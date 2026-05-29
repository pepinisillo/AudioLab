import json
import os
import subprocess
import time
from datetime import datetime, timezone
from uuid import uuid4

import boto3
import redis
from faster_whisper import WhisperModel


# El worker usa la misma configuracion que el backend para hablar con Redis.
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

# Cola real de pendientes. BLPOP saca una tarea de aqui cuando un worker la toma.
COLA_TAREAS = "cola:tareas"
SEGUNDOS_ESPERA_COLA = 5

# Estado de workers y logs compartidos para que FastAPI pueda mostrarlos despues.
PREFIJO_WORKER = "worker:"
LISTA_LOGS = "logs:sistema"
SEGUNDOS_EXPIRA_WORKER = 45

# Indices compartidos con la API para que la pantalla pueda ver progreso e historial.
INDICE_TAREAS = "tareas:ids"
INDICE_TAREAS_SET = "tareas:ids:set"

# Cada proceso puede tener un ID fijo por entorno; si no se pasa, se genera uno corto.
ID_WORKER = os.getenv("ID_WORKER", f"worker-{str(uuid4())[:8]}")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET = os.getenv("S3_BUCKET", "")
MODELO_WHISPER = os.getenv("MODELO_WHISPER", "tiny")

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    # BLPOP espera varios segundos; el socket necesita margen para que Redis pueda
    # responder None en vez de disparar un TimeoutError justo al vencimiento.
    socket_timeout=SEGUNDOS_ESPERA_COLA + 5,
    # Trabajar con strings simplifica json.loads/json.dumps.
    decode_responses=True
)

s3_cliente = boto3.client(
    "s3",
    region_name=AWS_REGION
)

ultimo_estado_reportado = None
modelo_whisper = None


def guardar_estado_worker(estado, tarea_actual=""):
    # Cada worker reporta su estado en un hash propio: worker:<id>.
    clave = f"{PREFIJO_WORKER}{ID_WORKER}"

    redis_cliente.hset(
        clave,
        mapping={
            "id": ID_WORKER,
            "estado": estado,
            "tarea_actual": tarea_actual or "",
            "ultima_vez": datetime.now(timezone.utc).isoformat(),
        }
    )
    redis_cliente.expire(clave, SEGUNDOS_EXPIRA_WORKER)


def agregar_log(mensaje):
    # Guarda logs recientes en Redis y tambien los manda a stdout para Docker.
    entrada = {
        "worker": ID_WORKER,
        "mensaje": mensaje,
        "fecha": datetime.now(timezone.utc).isoformat(),
    }

    redis_cliente.lpush(LISTA_LOGS, json.dumps(entrada, ensure_ascii=False))
    redis_cliente.ltrim(LISTA_LOGS, 0, 99)

    print(f"[{ID_WORKER}] {mensaje}")


def reportar_estado_worker(estado, tarea_actual=""):
    # El estado se actualiza siempre, pero el log solo cuando cambia para no llenar la consola.
    global ultimo_estado_reportado

    guardar_estado_worker(estado, tarea_actual)

    firma_estado = (estado, tarea_actual or "")

    if firma_estado == ultimo_estado_reportado:
        return

    ultimo_estado_reportado = firma_estado

    if estado == "esperando":
        agregar_log("esperando tareas")
    elif tarea_actual:
        agregar_log(f"{estado}: {tarea_actual}")
    else:
        agregar_log(estado)


def canal_eventos_trabajo(id_trabajo):
    # Canal Pub/Sub dedicado a un trabajo; FastAPI lo escucha y lo reenvia por SSE.
    return f"trabajo:{id_trabajo}:eventos"


def publicar_evento_tarea(tarea):
    # El evento incluye la tarea completa para que el frontend pueda actualizar sin volver a pedir todo.
    id_trabajo = tarea.get("id_trabajo")

    if not id_trabajo:
        return

    evento = {
        "tipo": "tarea_actualizada",
        "id_trabajo": id_trabajo,
        "id_tarea": tarea.get("id_tarea"),
        "estado": tarea.get("estado"),
        "progreso": tarea.get("progreso"),
        "worker": tarea.get("worker"),
        "tarea": tarea,
    }

    redis_cliente.publish(
        canal_eventos_trabajo(id_trabajo),
        json.dumps(evento, ensure_ascii=False)
    )


def guardar_estado_tarea(tarea):
    # Registrar aqui tambien protege el caso donde el worker reciba una tarea antigua sin indice.
    if redis_cliente.sadd(INDICE_TAREAS_SET, tarea["id_tarea"]):
        redis_cliente.rpush(INDICE_TAREAS, tarea["id_tarea"])

    # La UI lee esta clave para pintar estado, worker y barra de progreso.
    tarea["actualizado_en"] = time.time()
    clave = f"tarea:{tarea['id_tarea']}"
    redis_cliente.set(clave, json.dumps(tarea, ensure_ascii=False))
    publicar_evento_tarea(tarea)


def ruta_temporal_entrada(tarea):
    # Preservar extension ayuda a ffmpeg a detectar mejor algunos formatos.
    nombre_base = os.path.basename(
        tarea.get("s3_key") or tarea.get("nombre_archivo") or "entrada"
    )
    extension = os.path.splitext(nombre_base)[1] or ".audio"

    return os.path.join("/tmp", f"{tarea['id_tarea']}-entrada{extension}")


def obtener_bucket_tarea(tarea):
    bucket = tarea.get("s3_bucket") or S3_BUCKET

    if not bucket:
        raise ValueError("S3_BUCKET no esta configurado en el worker")

    return bucket


def descargar_desde_s3(s3_bucket, s3_key, ruta_local):
    s3_cliente.download_file(s3_bucket, s3_key, ruta_local)


def subir_a_s3(s3_bucket, ruta_local, s3_key_resultado, tipo_contenido):
    s3_cliente.upload_file(
        ruta_local,
        s3_bucket,
        s3_key_resultado,
        ExtraArgs={
            "ContentType": tipo_contenido
        }
    )


def ejecutar_ffmpeg(argumentos):
    # Capturar stderr deja errores utiles en Redis si ffmpeg no puede procesar el audio.
    try:
        subprocess.run(
            argumentos,
            check=True,
            capture_output=True,
            text=True
        )
    except subprocess.CalledProcessError as error:
        detalle = (error.stderr or error.stdout or str(error)).strip()
        raise RuntimeError(detalle[-1200:]) from error


def obtener_modelo_whisper():
    # Cargar el modelo solo cuando se usa evita gastar memoria en workers que procesan otras tareas.
    global modelo_whisper

    if modelo_whisper is None:
        agregar_log(f"cargando modelo Whisper en CPU: {MODELO_WHISPER}")
        modelo_whisper = WhisperModel(
            MODELO_WHISPER,
            device="cpu",
            compute_type="int8"
        )

    return modelo_whisper


def transcribir_audio(ruta_entrada):
    modelo = obtener_modelo_whisper()

    segmentos, _informacion = modelo.transcribe(
        ruta_entrada,
        language="es",
        beam_size=1,
        vad_filter=True
    )

    textos = []

    for segmento in segmentos:
        texto = segmento.text.strip()

        if texto:
            textos.append(texto)

    texto_final = " ".join(textos).strip()

    if not texto_final:
        texto_final = "No se detecto voz en el audio."

    return texto_final


def generar_resultado(tarea, ruta_entrada):
    proceso = tarea["proceso"]
    id_tarea = tarea["id_tarea"]

    if proceso == "transcripcion":
        ruta_salida = f"/tmp/{id_tarea}.txt"
        s3_key_resultado = f"resultados/{id_tarea}-transcripcion.txt"
        texto = transcribir_audio(ruta_entrada)

        with open(ruta_salida, "w", encoding="utf-8") as archivo:
            archivo.write(texto)
            archivo.write("\n")

        return ruta_salida, s3_key_resultado, "text/plain"

    if proceso == "lento":
        ruta_salida = f"/tmp/{id_tarea}-lento.wav"
        s3_key_resultado = f"resultados/{id_tarea}-lento.wav"

        ejecutar_ffmpeg([
            "ffmpeg", "-y",
            "-i", ruta_entrada,
            "-filter:a", "atempo=0.75",
            ruta_salida
        ])

        return ruta_salida, s3_key_resultado, "audio/wav"

    if proceso == "rapido":
        ruta_salida = f"/tmp/{id_tarea}-rapido.wav"
        s3_key_resultado = f"resultados/{id_tarea}-rapido.wav"

        ejecutar_ffmpeg([
            "ffmpeg", "-y",
            "-i", ruta_entrada,
            "-filter:a", "atempo=1.25",
            ruta_salida
        ])

        return ruta_salida, s3_key_resultado, "audio/wav"

    if proceso == "tono_grave":
        ruta_salida = f"/tmp/{id_tarea}-grave.wav"
        s3_key_resultado = f"resultados/{id_tarea}-grave.wav"

        ejecutar_ffmpeg([
            "ffmpeg", "-y",
            "-i", ruta_entrada,
            "-filter:a", "asetrate=44100*0.85,aresample=44100",
            ruta_salida
        ])

        return ruta_salida, s3_key_resultado, "audio/wav"

    if proceso == "tono_agudo":
        ruta_salida = f"/tmp/{id_tarea}-agudo.wav"
        s3_key_resultado = f"resultados/{id_tarea}-agudo.wav"

        ejecutar_ffmpeg([
            "ffmpeg", "-y",
            "-i", ruta_entrada,
            "-filter:a", "asetrate=44100*1.15,aresample=44100",
            ruta_salida
        ])

        return ruta_salida, s3_key_resultado, "audio/wav"

    if proceso == "onda":
        ruta_salida = f"/tmp/{id_tarea}-onda.png"
        s3_key_resultado = f"resultados/{id_tarea}-onda.png"

        ejecutar_ffmpeg([
            "ffmpeg", "-y",
            "-i", ruta_entrada,
            "-filter_complex", "showwavespic=s=1280x360",
            "-frames:v", "1",
            ruta_salida
        ])

        return ruta_salida, s3_key_resultado, "image/png"

    raise ValueError(f"Proceso no soportado: {proceso}")


def procesar_tarea(tarea):
    # Marcarla antes del trabajo pesado evita que la UI la siga viendo como pendiente.
    tarea["estado"] = "en proceso"
    tarea["progreso"] = 10
    tarea["worker"] = ID_WORKER
    tarea["resultado"] = None
    tarea["resultado_s3_key"] = None
    tarea["tipo_resultado"] = None
    tarea["error"] = None
    reportar_estado_worker("procesando", tarea["nombre"])
    guardar_estado_tarea(tarea)

    s3_bucket = obtener_bucket_tarea(tarea)
    s3_key = tarea.get("s3_key")

    if not s3_key:
        raise ValueError("La tarea no trae s3_key; crea el trabajo con /trabajos/s3")

    ruta_entrada = ruta_temporal_entrada(tarea)
    descargar_desde_s3(s3_bucket, s3_key, ruta_entrada)
    agregar_log(f"audio descargado desde S3: {s3_key}")

    tarea["progreso"] = 35
    guardar_estado_tarea(tarea)

    ruta_salida, s3_key_resultado, tipo_contenido = generar_resultado(
        tarea,
        ruta_entrada
    )

    tarea["progreso"] = 75
    guardar_estado_tarea(tarea)

    subir_a_s3(s3_bucket, ruta_salida, s3_key_resultado, tipo_contenido)
    agregar_log(f"resultado subido a S3: {s3_key_resultado}")

    tarea["estado"] = "completada"
    tarea["progreso"] = 100
    tarea["resultado"] = s3_key_resultado
    tarea["resultado_s3_key"] = s3_key_resultado
    tarea["tipo_resultado"] = tipo_contenido
    tarea["error"] = None
    guardar_estado_tarea(tarea)
    agregar_log(f"completada: {tarea['nombre']}")
    reportar_estado_worker("esperando")


def iniciar_worker():
    # Proceso largo: se queda esperando tareas hasta que se detenga manualmente.
    agregar_log("worker iniciado")
    reportar_estado_worker("esperando")

    while True:
        # BLPOP bloquea hasta 5 segundos; si no hay nada, vuelve a intentar sin gastar CPU de mas.
        try:
            resultado = redis_cliente.blpop(COLA_TAREAS, timeout=SEGUNDOS_ESPERA_COLA)
        except redis.exceptions.TimeoutError:
            # En Redis/redis-py el timeout del socket puede coincidir con el timeout
            # bloqueante de BLPOP. Para el worker, eso equivale a "sin tareas aun".
            reportar_estado_worker("esperando")
            continue

        if resultado is None:
            reportar_estado_worker("esperando")
            continue

        nombre_cola, tarea_json = resultado
        tarea = json.loads(tarea_json)

        try:
            procesar_tarea(tarea)
        except Exception as error:
            # Si algo falla, igual guardamos el error para que no quede invisible en la interfaz.
            tarea["estado"] = "error"
            tarea["error"] = str(error)
            tarea["worker"] = ID_WORKER
            guardar_estado_tarea(tarea)
            agregar_log(f"error en {tarea.get('nombre', 'tarea')}: {error}")
            reportar_estado_worker("error", tarea.get("nombre", ""))


if __name__ == "__main__":
    # Permite ejecutar este archivo directo: python worker/worker.py
    try:
        iniciar_worker()
    except KeyboardInterrupt:
        print(f"\n[{ID_WORKER}] worker detenido manualmente")
