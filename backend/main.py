from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from uuid import uuid4

aplicacion = FastAPI(title="AudioLab Cola API")
app = aplicacion

aplicacion.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NOMBRES_PROCESOS = {
    "transcripcion": "Transcripción",
    "lento": "Versión lenta",
    "rapido": "Versión rápida",
    "tono_grave": "Tono grave",
    "tono_agudo": "Tono agudo",
    "onda": "Generar onda",
}


@aplicacion.get("/")
async def inicio():
    return {
        "mensaje": "AudioLab Cola API funcionando"
    }


@aplicacion.post("/trabajos")
async def crear_trabajo(
    audio: UploadFile = File(...),
    procesos: str = Form(...)
):
    id_trabajo = str(uuid4())

    procesos_seleccionados = procesos.split(",")

    tareas = []

    for proceso in procesos_seleccionados:
        tarea = {
            "id_tarea": str(uuid4()),
            "id_trabajo": id_trabajo,
            "proceso": proceso,
            "nombre": NOMBRES_PROCESOS.get(proceso, proceso),
            "estado": "pendiente",
            "procesador": None,
            "resultado": None,
            "error": None,
        }

        tareas.append(tarea)

    return {
        "id_trabajo": id_trabajo,
        "nombre_archivo": audio.filename,
        "estado": "pendiente",
        "tareas": tareas,
    }
