import json
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

import boto3
import redis


# El worker usa la misma configuracion que el backend para hablar con Redis.
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

# Cola real de pendientes. BLPOP saca una tarea de aqui cuando un worker la toma.
COLA_TAREAS = "cola:tareas"

# Estado de workers y logs compartidos para que FastAPI pueda mostrarlos despues.
PREFIJO_WORKER = "worker:"
LISTA_LOGS = "logs:sistema"
SEGUNDOS_EXPIRA_WORKER = 45

# Indices compartidos con la API para que la pantalla pueda ver progreso e historial.
INDICE_TAREAS = "tareas:ids"
INDICE_TAREAS_SET = "tareas:ids:set"

# Cada proceso puede tener un ID fijo por entorno; si no se pasa, se genera uno corto.
ID_WORKER = os.getenv("ID_WORKER", f"worker-{str(uuid4())[:8]}")

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    # Trabajar con strings simplifica json.loads/json.dumps.
    decode_responses=True
)

s3_cliente = boto3.client(
    "s3",
    region_name=os.getenv("AWS_REGION", "us-east-1")
)

ultimo_estado_reportado = None


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


def ruta_temporal_audio(tarea):
    # Descargamos a /tmp porque es un espacio temporal seguro dentro del contenedor.
    nombre_base = os.path.basename(tarea.get("s3_key", "audio"))
    return os.path.join("/tmp", f"{tarea['id_tarea']}-{nombre_base}")


def descargar_audio_s3(tarea):
    # Por ahora solo confirmamos que el worker puede bajar el archivo desde S3.
    s3_bucket = tarea.get("s3_bucket")
    s3_key = tarea.get("s3_key")

    if not s3_bucket or not s3_key:
        agregar_log("tarea sin archivo S3, usando flujo simulado local")
        return None

    ruta_audio = ruta_temporal_audio(tarea)
    s3_cliente.download_file(s3_bucket, s3_key, ruta_audio)
    agregar_log(f"descargado desde S3: {s3_key}")

    return ruta_audio


def procesar_tarea(tarea):
    # Marcarla antes del trabajo pesado evita que la UI la siga viendo como pendiente.
    tarea["estado"] = "en proceso"
    tarea["progreso"] = 10
    tarea["worker"] = ID_WORKER
    reportar_estado_worker("procesando", tarea["nombre"])
    guardar_estado_tarea(tarea)

    ruta_audio = descargar_audio_s3(tarea)

    if ruta_audio:
        tarea["archivo_local"] = ruta_audio
        guardar_estado_tarea(tarea)

    # Simulacion del avance real. Cuando haya procesamiento de audio, se actualiza aqui.
    for progreso in [30, 50, 70, 90]:
        time.sleep(1)
        tarea["progreso"] = progreso
        guardar_estado_tarea(tarea)

    # Resultado simulado: mantiene el contrato de salida mientras no exista el procesamiento real.
    tarea["estado"] = "completada"
    tarea["progreso"] = 100
    tarea["resultado"] = f"Resultado simulado de {tarea['nombre']}"
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
        resultado = redis_cliente.blpop(COLA_TAREAS, timeout=5)

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
