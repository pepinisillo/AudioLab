import json
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

import redis


# El worker usa la misma configuracion que el backend para hablar con Redis.
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

# Cola real de pendientes. BLPOP saca una tarea de aqui cuando un worker la toma.
COLA_TAREAS = "cola:tareas"

# Estado de workers y logs compartidos para que FastAPI pueda mostrarlos despues.
PREFIJO_WORKER = "worker:"
LISTA_LOGS = "logs:sistema"

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


def procesar_tarea(tarea):
    # Marcarla antes del trabajo pesado evita que la UI la siga viendo como pendiente.
    tarea["estado"] = "en proceso"
    tarea["progreso"] = 10
    tarea["worker"] = ID_WORKER
    guardar_estado_worker("procesando", tarea["nombre"])
    guardar_estado_tarea(tarea)

    agregar_log(f"procesando: {tarea['nombre']}")

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
    guardar_estado_worker("esperando")


def iniciar_worker():
    # Proceso largo: se queda esperando tareas hasta que se detenga manualmente.
    guardar_estado_worker("esperando")
    agregar_log("worker iniciado")
    agregar_log(f"esperando tareas en {COLA_TAREAS}")

    while True:
        # BLPOP bloquea hasta 5 segundos; si no hay nada, vuelve a intentar sin gastar CPU de mas.
        resultado = redis_cliente.blpop(COLA_TAREAS, timeout=5)

        if resultado is None:
            guardar_estado_worker("esperando")
            agregar_log("sin tareas, esperando...")
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
            guardar_estado_worker("error", tarea.get("nombre", ""))


if __name__ == "__main__":
    # Permite ejecutar este archivo directo: python worker/worker.py
    try:
        iniciar_worker()
    except KeyboardInterrupt:
        print(f"\n[{ID_WORKER}] worker detenido manualmente")
