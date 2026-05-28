const AudioLab = (() => {
  const URL_API = "http://localhost:8000";

  const EXTENSIONES_ACEPTADAS = [".wav", ".mp3", ".ogg", ".m4a"];

  const TIPOS_ACEPTADOS = [
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/mp4",
    "audio/x-m4a"
  ];

  const elementos = {
    zonaArrastre: document.querySelector("#zonaArrastre"),
    entradaArchivo: document.querySelector("#entradaArchivo"),
    botonSeleccionarArchivo: document.querySelector("#botonSeleccionarArchivo"),
    detallesArchivo: document.querySelector("#detallesArchivo"),
    nombreArchivo: document.querySelector("[data-nombre-archivo]"),
    tamanoArchivo: document.querySelector("[data-tamano-archivo]"),
    tipoArchivo: document.querySelector("[data-tipo-archivo]"),
    reproductorAudio: document.querySelector("#vistaAudio"),
    etiquetaDuracion: document.querySelector("#etiquetaDuracion"),
    vistaPrevia: document.querySelector(".pila-vista-previa"),
    botonProcesar: document.querySelector("#botonProcesar"),
    ayudaEnvio: document.querySelector("#ayudaEnvio"),
    resumenTrabajo: document.querySelector("#resumenTrabajo"),
    tableroTareas: document.querySelector("#tableroTareas"),
    listaLogs: document.querySelector("#listaRegistros")
  };

  const entradasProcesos = Array.from(
    document.querySelectorAll(".opcion-proceso input")
  );

  const estado = {
    archivo: null,
    urlAudio: null,
    intervaloTrabajos: null
  };

  function iniciar() {
    conectarEventos();
    actualizarEstadoBoton();
    cargarTrabajosRedis();
    estado.intervaloTrabajos = window.setInterval(cargarTrabajosRedis, 1000);
    agregarLog("[sistema] interfaz lista");
  }

  function conectarEventos() {
    elementos.botonSeleccionarArchivo.addEventListener("click", (evento) => {
      evento.stopPropagation();
      elementos.entradaArchivo.click();
    });

    elementos.entradaArchivo.addEventListener("change", (evento) => {
      const archivo = evento.target.files[0];

      if (archivo) {
        manejarArchivo(archivo);
      }
    });

    elementos.zonaArrastre.addEventListener("click", (evento) => {
      if (evento.target !== elementos.botonSeleccionarArchivo) {
        elementos.entradaArchivo.click();
      }
    });

    elementos.zonaArrastre.addEventListener("dragover", (evento) => {
      evento.preventDefault();
      elementos.zonaArrastre.classList.add("is-dragging");
    });

    elementos.zonaArrastre.addEventListener("dragleave", (evento) => {
      evento.preventDefault();
      elementos.zonaArrastre.classList.remove("is-dragging");
    });

    elementos.zonaArrastre.addEventListener("drop", (evento) => {
      evento.preventDefault();
      elementos.zonaArrastre.classList.remove("is-dragging");

      const archivo = evento.dataTransfer.files[0];

      if (archivo) {
        manejarArchivo(archivo);
      }
    });

    entradasProcesos.forEach((entrada) => {
      entrada.addEventListener("change", actualizarEstadoBoton);
    });

    elementos.reproductorAudio.addEventListener("loadedmetadata", () => {
      elementos.etiquetaDuracion.textContent = formatearDuracion(
        elementos.reproductorAudio.duration
      );
    });

    elementos.botonProcesar.addEventListener("click", enviarTrabajo);
  }

  function manejarArchivo(archivo) {
    if (!esAudioAceptado(archivo)) {
      agregarLog(`[error] archivo rechazado: ${archivo.name}`);
      window.alert("Selecciona un archivo .wav, .mp3, .ogg o .m4a.");
      return;
    }

    if (estado.urlAudio) {
      URL.revokeObjectURL(estado.urlAudio);
    }

    estado.archivo = archivo;
    estado.urlAudio = URL.createObjectURL(archivo);

    elementos.reproductorAudio.src = estado.urlAudio;
    elementos.reproductorAudio.load();

    elementos.detallesArchivo.classList.remove("is-empty");
    elementos.vistaPrevia.classList.add("is-ready");

    elementos.nombreArchivo.textContent = archivo.name;
    elementos.tamanoArchivo.textContent = formatearBytes(archivo.size);
    elementos.tipoArchivo.textContent = archivo.type || inferirTipoPorNombre(archivo.name);
    elementos.etiquetaDuracion.textContent = "00:00";

    actualizarEstadoBoton();
    agregarLog(`[interfaz] archivo cargado: ${archivo.name}`);
  }

  function esAudioAceptado(archivo) {
    const nombreArchivo = archivo.name.toLowerCase();

    const tieneExtensionValida = EXTENSIONES_ACEPTADAS.some((extension) => {
      return nombreArchivo.endsWith(extension);
    });

    const tieneTipoValido = TIPOS_ACEPTADOS.includes(archivo.type);

    return tieneExtensionValida || tieneTipoValido;
  }

  function inferirTipoPorNombre(nombreArchivo) {
    const nombreMinusculas = nombreArchivo.toLowerCase();

    if (nombreMinusculas.endsWith(".wav")) return "audio/wav";
    if (nombreMinusculas.endsWith(".mp3")) return "audio/mpeg";
    if (nombreMinusculas.endsWith(".ogg")) return "audio/ogg";
    if (nombreMinusculas.endsWith(".m4a")) return "audio/mp4";

    return "audio/desconocido";
  }

  function obtenerProcesosSeleccionados() {
    return entradasProcesos
      .filter((entrada) => entrada.checked)
      .map((entrada) => {
        const opcion = entrada.closest(".opcion-proceso");
        const etiqueta = opcion?.querySelector("strong")?.textContent || entrada.value;

        return {
          valor: entrada.value,
          nombre: entrada.dataset.processName || etiqueta
        };
      });
  }

  function actualizarEstadoBoton() {
    const procesosSeleccionados = obtenerProcesosSeleccionados();
    const cantidadSeleccionada = procesosSeleccionados.length;

    const puedeEnviar = estado.archivo && cantidadSeleccionada > 0;

    elementos.botonProcesar.disabled = !puedeEnviar;

    if (!estado.archivo) {
      elementos.ayudaEnvio.textContent = "Carga un archivo y selecciona al menos un proceso.";
      return;
    }

    if (cantidadSeleccionada === 0) {
      elementos.ayudaEnvio.textContent = "Selecciona al menos un proceso para crear tareas.";
      return;
    }

    elementos.ayudaEnvio.textContent = `Listo: se crearán ${cantidadSeleccionada} tareas.`;
  }

  async function enviarTrabajo() {
    if (!estado.archivo) return;

    const procesosSeleccionados = obtenerProcesosSeleccionados();

    if (procesosSeleccionados.length === 0) return;

    elementos.botonProcesar.disabled = true;
    elementos.botonProcesar.textContent = "enviando trabajo...";

    agregarLog(`[interfaz] enviando ${procesosSeleccionados.length} procesos al backend`);

    try {
      const trabajo = await crearTrabajoEnBackend(
        estado.archivo,
        procesosSeleccionados
      );

      console.log("Respuesta de FastAPI:", trabajo);

      await cargarTrabajosRedis();

      agregarLog(`[servidor] trabajo creado: ${trabajo.id_trabajo}`);
    } catch (error) {
      console.error(error);
      agregarLog(`[error] ${error.message}`);
      window.alert("No se pudo crear el trabajo. Revisa que FastAPI esté encendido.");
    } finally {
      elementos.botonProcesar.textContent = "procesar audio";
      actualizarEstadoBoton();
    }
  }

  async function crearTrabajoEnBackend(archivo, procesos) {
    const formulario = new FormData();

    formulario.append("audio", archivo);

    const valoresProcesos = procesos.map((proceso) => proceso.valor);
    formulario.append("procesos", valoresProcesos.join(","));

    const respuesta = await fetch(`${URL_API}/trabajos`, {
      method: "POST",
      body: formulario
    });

    if (!respuesta.ok) {
      throw new Error(`POST /trabajos respondió ${respuesta.status}`);
    }

    return await respuesta.json();
  }

  async function cargarTrabajosRedis() {
    try {
      const respuesta = await fetch(`${URL_API}/trabajos`);

      if (!respuesta.ok) {
        throw new Error(`GET /trabajos respondió ${respuesta.status}`);
      }

      const datos = await respuesta.json();
      const tareas = Array.isArray(datos.tareas) ? datos.tareas : [];

      mostrarTrabajosRedis(tareas);
    } catch (error) {
      console.error(error);
      agregarLog(`[error] no se pudieron leer los trabajos de Redis: ${error.message}`);
      mostrarTrabajosRedis([]);
    }
  }

  function mostrarTrabajosRedis(tareas) {
    elementos.tableroTareas.replaceChildren();

    if (elementos.resumenTrabajo) {
      elementos.resumenTrabajo.textContent = `${tareas.length} tareas registradas`;
    }

    if (tareas.length === 0) {
      elementos.tableroTareas.classList.add("estado-vacio");

      const mensaje = document.createElement("p");
      mensaje.textContent = "No hay tareas registradas en Redis.";

      elementos.tableroTareas.append(mensaje);
      return;
    }

    elementos.tableroTareas.classList.remove("estado-vacio");

    const trabajosAgrupados = agruparTareasPorTrabajo(tareas);

    trabajosAgrupados.forEach((grupo) => {
      const tarjetaTrabajo = document.createElement("article");
      tarjetaTrabajo.className = "tarjeta-trabajo";

      const encabezado = document.createElement("div");
      encabezado.className = "encabezado-tarjeta-trabajo";

      const contenedorTitulo = document.createElement("div");

      const titulo = document.createElement("strong");
      titulo.textContent = `Trabajo: ${grupo.nombre_archivo || abreviarId(grupo.id_trabajo)}`;

      const detalle = document.createElement("p");
      detalle.className = "nombre-worker";
      detalle.textContent = `${grupo.tareas.length} tareas registradas`;

      contenedorTitulo.append(titulo, detalle);

      const insignia = document.createElement("span");
      insignia.className = "resumen-trabajo";
      insignia.textContent = estadoGrupoTrabajo(grupo.tareas);

      encabezado.append(contenedorTitulo, insignia);

      const listaTareas = document.createElement("div");
      listaTareas.className = "lista-tareas";

      grupo.tareas.forEach((tarea) => {
        const tarjetaTarea = crearTarjetaTarea(normalizarTareaCola(tarea));
        listaTareas.append(tarjetaTarea);
      });

      tarjetaTrabajo.append(encabezado, listaTareas);
      elementos.tableroTareas.append(tarjetaTrabajo);
    });
  }

  function crearTarjetaTarea(tarea) {
    const tarjeta = document.createElement("article");
    tarjeta.className = "tarjeta-tarea";

    const contenido = document.createElement("div");
    const filaTitulo = document.createElement("div");
    filaTitulo.className = "fila-titulo-tarea";

    const texto = document.createElement("strong");
    texto.textContent = tarea.nombre;

    const descripcion = document.createElement("p");
    descripcion.className = "mensaje-tarea";
    descripcion.textContent = tarea.proceso
      ? `Proceso: ${tarea.proceso}${tarea.id_tarea ? ` · ${abreviarId(tarea.id_tarea)}` : ""}`
      : tarea.id_tarea
        ? `Tarea: ${abreviarId(tarea.id_tarea)}`
        : "";

    filaTitulo.append(texto, crearInsigniaEstado(tarea.estado));
    contenido.append(filaTitulo);
    if (descripcion.textContent) {
      contenido.append(descripcion);
    }

    const progreso = document.createElement("div");
    progreso.className = "contenedor-progreso";
    progreso.setAttribute("aria-label", `Progreso de ${tarea.nombre}`);

    const relleno = document.createElement("span");
    relleno.className = "relleno-progreso";
    relleno.style.setProperty("--progreso", `${normalizarProgreso(tarea)}%`);

    progreso.append(relleno);
    contenido.append(progreso);

    const acciones = document.createElement("div");
    acciones.className = "acciones-tarea";
    rellenarAccionesTarea(acciones, tarea);

    tarjeta.append(contenido, acciones);

    return tarjeta;
  }

  function normalizarTrabajoParaVista(trabajo) {
    const tareas = Array.isArray(trabajo.tareas) ? [...trabajo.tareas] : [];

    return {
      nombre_archivo: trabajo.nombre_archivo || "audio desconocido",
      estado: trabajo.estado || "pendiente",
      tareas
    };
  }

  function agruparTareasPorTrabajo(tareas) {
    const grupos = new Map();

    tareas.forEach((tarea) => {
      const idTrabajo = String(tarea.id_trabajo || "sin-trabajo");

      if (!grupos.has(idTrabajo)) {
        grupos.set(idTrabajo, {
          id_trabajo: idTrabajo,
          nombre_archivo: tarea.nombre_archivo || "",
          tareas: []
        });
      }

      const grupo = grupos.get(idTrabajo);

      if (!grupo.nombre_archivo && tarea.nombre_archivo) {
        grupo.nombre_archivo = tarea.nombre_archivo;
      }

      grupo.tareas.push(tarea);
    });

    return Array.from(grupos.values());
  }

  function normalizarTareaCola(tarea) {
    return {
      id_tarea: tarea.id_tarea,
      id_trabajo: tarea.id_trabajo,
      nombre_archivo: tarea.nombre_archivo || "",
      proceso: tarea.proceso,
      nombre: tarea.nombre || tarea.proceso || "tarea",
      estado: tarea.estado || "pendiente",
      progreso: tarea.progreso,
      worker: tarea.worker || null,
      resultado: tarea.resultado || null,
      error: tarea.error || null,
      urlResultado: tarea.urlResultado || tarea.resultado || ""
    };
  }

  function estadoGrupoTrabajo(tareas) {
    if (tareas.some((tarea) => claseEstado(tarea.estado) === "error")) {
      return "con errores";
    }

    if (tareas.every((tarea) => claseEstado(tarea.estado) === "completada")) {
      return "completado";
    }

    if (tareas.some((tarea) => claseEstado(tarea.estado) === "en-proceso")) {
      return "en proceso";
    }

    return "pendiente";
  }

  function normalizarProgreso(tarea) {
    const progreso = Number(tarea.progreso);

    if (Number.isFinite(progreso)) {
      return Math.max(0, Math.min(100, progreso));
    }

    const estadoNormalizado = claseEstado(tarea.estado);

    if (estadoNormalizado === "completada") return 100;
    if (estadoNormalizado === "en-proceso") return 50;
    if (estadoNormalizado === "error") return 100;

    return 0;
  }

  function abreviarId(id) {
    return String(id || "").slice(0, 8);
  }

  function crearInsigniaEstado(estadoTarea) {
    const insignia = document.createElement("span");
    insignia.className = `insignia-estado ${claseEstado(estadoTarea)}`;
    insignia.textContent = etiquetaEstado(estadoTarea);

    return insignia;
  }

  function claseEstado(estadoTarea) {
    const normalizado = String(estadoTarea || "").trim().toLowerCase();

    if (normalizado === "pendiente" || normalizado === "pending") return "pendiente";
    if (normalizado === "en proceso" || normalizado === "en_proceso" || normalizado === "running") return "en-proceso";
    if (normalizado === "completada" || normalizado === "completed") return "completada";
    if (normalizado === "error") return "error";

    return "pendiente";
  }

  function etiquetaEstado(estadoTarea) {
    const normalizado = String(estadoTarea || "").trim().toLowerCase();

    if (normalizado === "pending") return "pendiente";
    if (normalizado === "running" || normalizado === "en_proceso") return "en proceso";
    if (normalizado === "completed") return "completada";

    return normalizado || "pendiente";
  }

  function rellenarAccionesTarea(contenedor, tarea) {
    contenedor.replaceChildren();

    if (tarea.estado !== "completada") {
      return;
    }

    const enlace = document.createElement("a");
    enlace.className = "enlace-resultado";
    enlace.href = tarea.urlResultado || "#";
    enlace.textContent = tarea.proceso === "onda" ? "ver onda" : "reproducir";

    contenedor.append(enlace);
  }

  function agregarLog(mensaje) {
    if (!elementos.listaLogs) return;

    const entrada = document.createElement("li");
    entrada.textContent = mensaje;

    elementos.listaLogs.prepend(entrada);
  }

  function formatearBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes === 0) {
      return "0 B";
    }

    const unidades = ["B", "KB", "MB", "GB"];

    const indice = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      unidades.length - 1
    );

    const valor = bytes / (1024 ** indice);

    return `${valor.toFixed(valor >= 10 || indice === 0 ? 0 : 1)} ${unidades[indice]}`;
  }

  function formatearDuracion(segundos) {
    if (!Number.isFinite(segundos)) {
      return "00:00";
    }

    const minutos = Math.floor(segundos / 60);
    const segundosRestantes = Math.floor(segundos % 60);

    return `${String(minutos).padStart(2, "0")}:${String(segundosRestantes).padStart(2, "0")}`;
  }

  return {
    iniciar
  };
})();

AudioLab.iniciar();
