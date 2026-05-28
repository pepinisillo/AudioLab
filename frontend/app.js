// Todo el frontend queda dentro de un solo modulo para no dejar variables sueltas en window.
const AudioLab = (() => {
  // Backend de FastAPI. En Docker usa el mismo host que abrio el navegador y el puerto publicado 8000.
  const URL_API = obtenerUrlApi();

  // El historial vive en el navegador; Redis se usa para el trabajo actual.
  const CLAVE_HISTORIAL = "audiolab:historial-trabajos";

  // Guarda trabajos que ya se borraron del historial para que no reaparezcan
  // mientras sigan existiendo en Redis.
  const CLAVE_HISTORIAL_OCULTO = "audiolab:historial-trabajos-ocultos";
  const MAXIMO_HISTORIAL = 40;

  // Validamos por extension y por MIME porque algunos navegadores dejan el MIME vacio.
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

  function obtenerUrlApi() {
    // Permite sobreescribir desde index.html si algun dia se sirve detras de proxy o dominio fijo.
    const urlConfigurada = window.AudioLabConfig?.urlApi;

    if (urlConfigurada) {
      return urlConfigurada.replace(/\/$/, "");
    }

    // Cuando el frontend se abre por http(s), el backend publicado por Docker vive en el mismo host.
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return `${window.location.protocol}//${window.location.hostname}:8000`;
    }

    // Si se abre como archivo local, no hay hostname; usamos el puerto publicado del compose.
    return "http://localhost:8000";
  }

  // Mapa central de elementos del DOM. Asi evitamos repetir querySelector por todo el archivo.
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
    botonLimpiarTrabajo: document.querySelector("#botonLimpiarTrabajo"),
    tableroTareas: document.querySelector("#tableroTareas"),
    estadoWorkersCabecera: document.querySelector(".pastilla-estado.esta-ocupado"),
    metricaWorkers: document.querySelector("#metricaWorkers"),
    metricaPendientes: document.querySelector("#metricaPendientes"),
    metricaEnProceso: document.querySelector("#metricaEnProceso"),
    metricaCompletadas: document.querySelector("#metricaCompletadas"),
    metricaErrores: document.querySelector("#metricaErrores"),
    listaLogs: document.querySelector("#listaRegistros"),
    botonLimpiarRegistros: document.querySelector("#botonLimpiarRegistros"),
    listaHistorial: document.querySelector("#listaHistorial"),
    botonLimpiarHistorial: document.querySelector("#botonLimpiarHistorial")
  };

  // Checkboxes que definen cuantas tareas se van a crear para un trabajo.
  const entradasProcesos = Array.from(
    document.querySelectorAll(".opcion-proceso input")
  );

  // Estado minimo de la interfaz. Redis sigue siendo la fuente del estado de las tareas.
  const estado = {
    archivo: null,
    urlAudio: null,
    tareasActuales: [],
    logsLocales: [],
    logsSistema: [],
    workersSistema: [],
    coloresWorkers: new Map(),
    eventosTrabajos: new Map(),
    intervaloTrabajos: null,
    intervaloSistema: null,
    errorSistemaReportado: false
  };

  function iniciar() {
    // Orden de arranque: eventos, estado visual inicial, historial local y luego Redis.
    conectarEventos();
    actualizarEstadoBoton();
    renderizarHistorial();
    cargarTrabajosRedis();
    cargarEstadoSistema();
    estado.intervaloSistema = window.setInterval(cargarEstadoSistema, 2000);

    if (!("EventSource" in window)) {
      estado.intervaloTrabajos = window.setInterval(cargarTrabajosRedis, 1000);
      agregarLog("[sistema] SSE no disponible; usando actualizacion por intervalo");
    }

    agregarLog("[sistema] interfaz lista");
  }

  function conectarEventos() {
    // El boton interno abre el file picker sin disparar dos veces el click de la zona.
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

    // Drag and drop solo cambia la UI hasta que realmente se suelta un archivo.
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
    elementos.botonLimpiarTrabajo?.addEventListener("click", limpiarTrabajoActual);
    elementos.botonLimpiarRegistros?.addEventListener("click", limpiarRegistros);
    elementos.botonLimpiarHistorial?.addEventListener("click", limpiarHistorial);
  }

  function manejarArchivo(archivo) {
    // Se corta temprano para no crear vista previa ni enviar archivos no soportados.
    if (!esAudioAceptado(archivo)) {
      agregarLog(`[error] archivo rechazado: ${archivo.name}`);
      window.alert("Selecciona un archivo .wav, .mp3, .ogg o .m4a.");
      return;
    }

    // Cada archivo nuevo crea una URL temporal; revocar la anterior evita fugas de memoria.
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
    // No dependemos solo del MIME porque arrastrar archivos puede venir sin tipo confiable.
    const nombreArchivo = archivo.name.toLowerCase();

    const tieneExtensionValida = EXTENSIONES_ACEPTADAS.some((extension) => {
      return nombreArchivo.endsWith(extension);
    });

    const tieneTipoValido = TIPOS_ACEPTADOS.includes(archivo.type);

    return tieneExtensionValida || tieneTipoValido;
  }

  function inferirTipoPorNombre(nombreArchivo) {
    // Texto de respaldo para mostrar en la ficha del archivo cuando el navegador no da MIME.
    const nombreMinusculas = nombreArchivo.toLowerCase();

    if (nombreMinusculas.endsWith(".wav")) return "audio/wav";
    if (nombreMinusculas.endsWith(".mp3")) return "audio/mpeg";
    if (nombreMinusculas.endsWith(".ogg")) return "audio/ogg";
    if (nombreMinusculas.endsWith(".m4a")) return "audio/mp4";

    return "audio/desconocido";
  }

  function obtenerProcesosSeleccionados() {
    // El backend necesita el valor tecnico; la UI conserva tambien el nombre legible.
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
    // No se puede crear trabajo sin archivo y sin al menos un proceso marcado.
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
    // Este es el punto donde la UI pasa de "configurar" a "crear tareas en Redis".
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

      // Se consulta Redis inmediatamente para que aparezcan tareas aunque el worker las tome rapido.
      await cargarTrabajosRedis();

      agregarLog(`[servidor] trabajo creado: ${trabajo.id_trabajo}`);
    } catch (error) {
      console.error(error);
      agregarLog(`[error] ${error.message}`);
      window.alert("No se pudo crear el trabajo. Revisa FastAPI, S3 y las credenciales AWS.");
    } finally {
      elementos.botonProcesar.textContent = "procesar audio";
      actualizarEstadoBoton();
    }
  }

  async function crearTrabajoEnBackend(archivo, procesos) {
    // Flujo S3: el archivo no pasa por FastAPI; el navegador lo sube directo al bucket.
    const s3Key = await subirAudioAS3(archivo);
    const valoresProcesos = procesos.map((proceso) => proceso.valor || proceso.value);

    const respuesta = await fetch(`${URL_API}/trabajos/s3`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        nombre_archivo: archivo.name,
        s3_key: s3Key,
        procesos: valoresProcesos
      })
    });

    if (!respuesta.ok) {
      throw new Error(`POST /trabajos/s3 respondió ${respuesta.status}`);
    }

    return await respuesta.json();
  }

  async function subirAudioAS3(archivo) {
    const tipoArchivo = obtenerTipoArchivoSubida(archivo);

    agregarLog("[interfaz] pidiendo permiso temporal de subida a S3");

    const respuestaFirma = await fetch(`${URL_API}/s3/signed-post`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        nombre_archivo: archivo.name,
        tipo_archivo: tipoArchivo
      })
    });

    if (!respuestaFirma.ok) {
      throw new Error(`POST /s3/signed-post respondió ${respuestaFirma.status}`);
    }

    const firma = await respuestaFirma.json();
    const formularioS3 = new FormData();

    Object.entries(firma.fields || {}).forEach(([clave, valor]) => {
      formularioS3.append(clave, valor);
    });

    formularioS3.set("Content-Type", tipoArchivo);
    formularioS3.append("file", archivo);

    agregarLog("[interfaz] subiendo audio a S3");

    const respuestaS3 = await fetch(firma.url, {
      method: "POST",
      body: formularioS3
    });

    if (!respuestaS3.ok) {
      throw new Error(`S3 respondió ${respuestaS3.status}`);
    }

    return firma.s3_key;
  }

  function obtenerTipoArchivoSubida(archivo) {
    const tipoInferido = archivo.type || inferirTipoPorNombre(archivo.name);
    return tipoInferido === "audio/desconocido" ? "audio/wav" : tipoInferido;
  }

  async function cargarTrabajosRedis() {
    // Carga inicial y respaldo manual: SSE se encarga de los cambios despues de conectar.
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

  async function cargarEstadoSistema() {
    // Workers y logs viven en Redis; el backend los expone en endpoints separados.
    try {
      const [respuestaWorkers, respuestaLogs] = await Promise.all([
        fetch(`${URL_API}/workers`),
        fetch(`${URL_API}/logs`)
      ]);

      if (!respuestaWorkers.ok) {
        throw new Error(`GET /workers respondió ${respuestaWorkers.status}`);
      }

      if (!respuestaLogs.ok) {
        throw new Error(`GET /logs respondió ${respuestaLogs.status}`);
      }

      const datosWorkers = await respuestaWorkers.json();
      const datosLogs = await respuestaLogs.json();

      estado.errorSistemaReportado = false;
      mostrarWorkersSistema(datosWorkers);
      mostrarLogsSistema(datosLogs.logs);
    } catch (error) {
      console.error(error);

      if (!estado.errorSistemaReportado) {
        estado.errorSistemaReportado = true;
        agregarLog(`[error] no se pudo leer el estado del sistema: ${error.message}`);
      }
    }
  }

  function mostrarWorkersSistema(datosWorkers) {
    const workers = Array.isArray(datosWorkers.workers) ? datosWorkers.workers : [];
    const activos = Number.isFinite(Number(datosWorkers.activos))
      ? Number(datosWorkers.activos)
      : workers.filter((worker) => worker.activo).length;

    estado.workersSistema = workers.filter((worker) => worker.activo);

    if (elementos.metricaWorkers) {
      elementos.metricaWorkers.textContent = String(activos);
    }

    if (elementos.estadoWorkersCabecera) {
      elementos.estadoWorkersCabecera.lastChild.textContent = ` ${activos} workers activos`;
    }

    renderizarLogs();
  }

  function mostrarLogsSistema(logs) {
    estado.logsSistema = Array.isArray(logs) ? logs : [];
    renderizarLogs();
  }

  function sincronizarEventosTrabajos(trabajosAgrupados) {
    // Abre una conexion SSE por trabajo activo y cierra las que ya no hacen falta.
    if (!("EventSource" in window)) return;

    const idsVisibles = new Set(
      trabajosAgrupados
        .filter((grupo) => !trabajoEstaTerminado(grupo.tareas))
        .map((grupo) => grupo.id_trabajo)
        .filter((idTrabajo) => idTrabajo && idTrabajo !== "sin-trabajo")
    );

    Array.from(estado.eventosTrabajos.keys()).forEach((idTrabajo) => {
      if (!idsVisibles.has(idTrabajo)) {
        cerrarEventosTrabajo(idTrabajo);
      }
    });

    idsVisibles.forEach((idTrabajo) => {
      abrirEventosTrabajo(idTrabajo);
    });
  }

  function abrirEventosTrabajo(idTrabajo) {
    if (estado.eventosTrabajos.has(idTrabajo)) return;

    const fuente = new EventSource(
      `${URL_API}/trabajos/${encodeURIComponent(idTrabajo)}/eventos`
    );

    const conexion = {
      fuente,
      errorReportado: false
    };

    fuente.addEventListener("conexion", () => {
      conexion.errorReportado = false;
      agregarLog(`[sse] escuchando trabajo ${abreviarId(idTrabajo)}`);
    });

    fuente.addEventListener("tarea_actualizada", (evento) => {
      try {
        const datos = JSON.parse(evento.data);
        aplicarEventoTarea(datos);
      } catch (error) {
        console.error(error);
        agregarLog(`[error] evento SSE invalido: ${error.message}`);
      }
    });

    fuente.onerror = () => {
      if (conexion.errorReportado) return;

      conexion.errorReportado = true;
      agregarLog(`[sse] reconectando trabajo ${abreviarId(idTrabajo)}`);
    };

    estado.eventosTrabajos.set(idTrabajo, conexion);
  }

  function cerrarEventosTrabajo(idTrabajo) {
    const conexion = estado.eventosTrabajos.get(idTrabajo);

    if (!conexion) return;

    conexion.fuente.close();
    estado.eventosTrabajos.delete(idTrabajo);
  }

  function cerrarTodosLosEventosTrabajo() {
    Array.from(estado.eventosTrabajos.keys()).forEach(cerrarEventosTrabajo);
  }

  function aplicarEventoTarea(evento) {
    // El worker manda la tarea completa; con eso actualizamos la tarjeta sin pedir /trabajos otra vez.
    const tareaActualizada = evento.tarea || evento;

    if (!tareaActualizada.id_tarea) {
      return;
    }

    const tareas = [...estado.tareasActuales];
    const indice = tareas.findIndex((tarea) => {
      return tarea.id_tarea === tareaActualizada.id_tarea;
    });

    if (indice >= 0) {
      tareas[indice] = {
        ...tareas[indice],
        ...tareaActualizada
      };
    } else {
      tareas.push(tareaActualizada);
    }

    mostrarTrabajosRedis(tareas);
  }

  async function limpiarTrabajoActual() {
    // Solo borramos cuando ya no hay tareas pendientes o en proceso.
    if (!puedeLimpiarTrabajo(estado.tareasActuales)) {
      return;
    }

    if (elementos.botonLimpiarTrabajo) {
      elementos.botonLimpiarTrabajo.disabled = true;
    }
    agregarLog("[interfaz] limpiando trabajo actual en Redis");

    try {
      const respuesta = await fetch(`${URL_API}/trabajos`, {
        method: "DELETE"
      });

      if (!respuesta.ok) {
        throw new Error(`DELETE /trabajos respondió ${respuesta.status}`);
      }

      const datos = await respuesta.json();
      mostrarTrabajosRedis([]);
      agregarLog(`[servidor] trabajo actual limpiado: ${datos.eliminadas || 0} tareas`);
    } catch (error) {
      console.error(error);
      agregarLog(`[error] no se pudo limpiar el trabajo actual: ${error.message}`);
      actualizarBotonLimpiarTrabajo(estado.tareasActuales);
    }
  }

  function mostrarTrabajosRedis(tareas) {
    // Esta funcion reconstruye el tablero completo desde Redis; no intenta parchear el DOM viejo.
    estado.tareasActuales = tareas;
    elementos.tableroTareas.replaceChildren();
    actualizarMetricasTareas(tareas);
    actualizarBotonLimpiarTrabajo(tareas);

    if (elementos.resumenTrabajo) {
      elementos.resumenTrabajo.textContent = `${tareas.length} tareas registradas`;
    }

    if (tareas.length === 0) {
      elementos.tableroTareas.classList.add("estado-vacio");
      cerrarTodosLosEventosTrabajo();

      const mensaje = document.createElement("p");
      mensaje.textContent = "No hay tareas registradas en Redis.";

      elementos.tableroTareas.append(mensaje);
      return;
    }

    elementos.tableroTareas.classList.remove("estado-vacio");

    // Redis guarda tareas sueltas, pero la pantalla las muestra agrupadas por trabajo.
    const trabajosAgrupados = agruparTareasPorTrabajo(tareas);
    sincronizarEventosTrabajos(trabajosAgrupados);
    guardarTrabajosCompletadosEnHistorial(trabajosAgrupados);

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

  function actualizarMetricasTareas(tareas) {
    // Metricas del tablero calculadas desde las tareas que llegaron de Redis.
    const conteo = {
      pendiente: 0,
      "en-proceso": 0,
      completada: 0,
      error: 0
    };

    tareas.forEach((tarea) => {
      conteo[claseEstado(tarea.estado)] += 1;
    });

    if (elementos.metricaPendientes) {
      elementos.metricaPendientes.textContent = String(conteo.pendiente);
    }

    if (elementos.metricaEnProceso) {
      elementos.metricaEnProceso.textContent = String(conteo["en-proceso"]);
    }

    if (elementos.metricaCompletadas) {
      elementos.metricaCompletadas.textContent = String(conteo.completada);
    }

    if (elementos.metricaErrores) {
      elementos.metricaErrores.textContent = String(conteo.error);
    }
  }

  function actualizarBotonLimpiarTrabajo(tareas) {
    // El borrado de Redis se habilita al final para no pelearse con un worker activo.
    if (!elementos.botonLimpiarTrabajo) return;

    const hayTareas = Array.isArray(tareas) && tareas.length > 0;
    const puedeLimpiar = puedeLimpiarTrabajo(tareas);
    const titulo = !hayTareas
      ? "No hay trabajos para limpiar"
      : puedeLimpiar
        ? "Limpiar trabajo actual"
        : "Disponible cuando terminen las tareas";

    elementos.botonLimpiarTrabajo.disabled = !puedeLimpiar;
    elementos.botonLimpiarTrabajo.title = titulo;
    elementos.botonLimpiarTrabajo.setAttribute("aria-label", titulo);
  }

  function puedeLimpiarTrabajo(tareas) {
    // El boton aparece siempre, pero solo se puede picar cuando todo termino.
    return Array.isArray(tareas) && tareas.length > 0 && tareas.every(tareaEstaTerminada);
  }

  function trabajoEstaTerminado(tareas) {
    // Un trabajo con error tambien cuenta como terminado: ya no lo va a seguir procesando el worker.
    return Array.isArray(tareas) && tareas.length > 0 && tareas.every(tareaEstaTerminada);
  }

  function tareaEstaTerminada(tarea) {
    const estadoNormalizado = claseEstado(tarea?.estado);
    return estadoNormalizado === "completada" || estadoNormalizado === "error";
  }

  function guardarTrabajosCompletadosEnHistorial(trabajosAgrupados) {
    // El historial se llena desde trabajos terminados, no desde cada tarea individual.
    const idsOcultos = leerIdsHistorialOcultos();
    const trabajosTerminados = trabajosAgrupados.filter((grupo) => {
      return trabajoEstaTerminado(grupo.tareas) && !idsOcultos.has(grupo.id_trabajo);
    });

    if (trabajosTerminados.length === 0) {
      return;
    }

    // Se usa Map para actualizar el mismo trabajo sin duplicarlo si el polling vuelve a verlo.
    const historial = leerHistorial();
    const historialPorId = new Map(
      historial.map((item) => [item.id_trabajo, item])
    );
    let cambio = false;

    trabajosTerminados.forEach((grupo) => {
      const item = crearItemHistorial(grupo);
      const itemAnterior = historialPorId.get(item.id_trabajo);

      if (!itemAnterior || JSON.stringify(itemAnterior) !== JSON.stringify(item)) {
        historialPorId.set(item.id_trabajo, item);
        cambio = true;
      }
    });

    if (!cambio) {
      return;
    }

    const historialActualizado = Array.from(historialPorId.values())
      .sort((a, b) => Number(b.actualizado_en || 0) - Number(a.actualizado_en || 0))
      .slice(0, MAXIMO_HISTORIAL);

    guardarHistorial(historialActualizado);
    renderizarHistorial(historialActualizado);
  }

  function crearItemHistorial(grupo) {
    // Compacta un trabajo completo a los datos que necesita la lista de historial.
    const tareas = Array.isArray(grupo.tareas) ? grupo.tareas : [];
    const completadas = tareas.filter((tarea) => claseEstado(tarea.estado) === "completada").length;
    const errores = tareas.filter((tarea) => claseEstado(tarea.estado) === "error").length;

    return {
      id_trabajo: grupo.id_trabajo,
      nombre_archivo: grupo.nombre_archivo || "audio desconocido",
      total: tareas.length,
      completadas,
      errores,
      estado: errores > 0 ? "con errores" : "completado",
      actualizado_en: obtenerFechaTrabajo(tareas)
    };
  }

  function obtenerFechaTrabajo(tareas) {
    // La fecha del trabajo es la ultima actualizacion entre sus tareas.
    const marcasTiempo = tareas
      .map((tarea) => Number(tarea.actualizado_en || tarea.creado_en))
      .filter(Number.isFinite);

    if (marcasTiempo.length === 0) {
      return Date.now() / 1000;
    }

    return Math.max(...marcasTiempo);
  }

  function renderizarHistorial(historial = leerHistorial()) {
    // Se renderiza desde localStorage para que sobreviva a refresh de pagina.
    if (!elementos.listaHistorial) return;

    elementos.listaHistorial.replaceChildren();
    elementos.listaHistorial.classList.toggle("estado-vacio", historial.length === 0);
    actualizarBotonLimpiarHistorial(historial.length > 0);

    if (historial.length === 0) {
      const mensaje = document.createElement("p");
      mensaje.textContent = "Aún no hay trabajos guardados en el almacenamiento local.";
      elementos.listaHistorial.append(mensaje);
      return;
    }

    historial.forEach((trabajo) => {
      const item = document.createElement("article");
      item.className = "item-historial";

      const contenido = document.createElement("div");

      const titulo = document.createElement("strong");
      titulo.textContent = trabajo.nombre_archivo || "audio desconocido";

      const meta = document.createElement("div");
      meta.className = "meta-historial";

      [
        `${trabajo.completadas || 0}/${trabajo.total || 0} completadas`,
        trabajo.errores ? `${trabajo.errores} errores` : "sin errores",
        trabajo.estado || "completado",
        formatearFecha(trabajo.actualizado_en),
        `trabajo ${abreviarId(trabajo.id_trabajo)}`
      ].forEach((texto) => {
        const etiqueta = document.createElement("span");
        etiqueta.textContent = texto;
        meta.append(etiqueta);
      });

      contenido.append(titulo, meta);
      item.append(contenido);
      elementos.listaHistorial.append(item);
    });
  }

  function actualizarBotonLimpiarHistorial(tieneHistorial) {
    // El icono queda visible siempre; disabled comunica cuando no hay nada que borrar.
    if (!elementos.botonLimpiarHistorial) return;

    const titulo = tieneHistorial
      ? "Limpiar historial"
      : "No hay historial para limpiar";

    elementos.botonLimpiarHistorial.disabled = !tieneHistorial;
    elementos.botonLimpiarHistorial.title = titulo;
    elementos.botonLimpiarHistorial.setAttribute("aria-label", titulo);
  }

  function limpiarHistorial() {
    // Si Redis aun conserva trabajos completados, se ocultan para que no reaparezcan al siguiente refresco.
    const historial = leerHistorial();
    const idsOcultos = leerIdsHistorialOcultos();

    historial.forEach((trabajo) => {
      if (trabajo.id_trabajo) {
        idsOcultos.add(trabajo.id_trabajo);
      }
    });

    agruparTareasPorTrabajo(estado.tareasActuales)
      .filter((grupo) => trabajoEstaTerminado(grupo.tareas))
      .forEach((grupo) => idsOcultos.add(grupo.id_trabajo));

    guardarIdsHistorialOcultos(idsOcultos);
    borrarHistorialGuardado();
    renderizarHistorial([]);
    agregarLog("[interfaz] historial limpiado");
  }

  function leerHistorial() {
    // Cualquier problema leyendo localStorage deja la UI vacia, no rompe toda la app.
    try {
      const datos = JSON.parse(window.localStorage.getItem(CLAVE_HISTORIAL) || "[]");
      return Array.isArray(datos) ? datos : [];
    } catch (error) {
      console.warn("No se pudo leer el historial local:", error);
      return [];
    }
  }

  function guardarHistorial(historial) {
    // LocalStorage es suficiente por ahora: historial de pantalla, no historial del servidor.
    try {
      window.localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify(historial));
    } catch (error) {
      console.warn("No se pudo guardar el historial local:", error);
    }
  }

  function borrarHistorialGuardado() {
    // Borra solo el historial visible; los trabajos actuales siguen viviendo en Redis.
    try {
      window.localStorage.removeItem(CLAVE_HISTORIAL);
    } catch (error) {
      console.warn("No se pudo borrar el historial local:", error);
    }
  }

  function leerIdsHistorialOcultos() {
    // Lista auxiliar para recordar que el usuario ya limpio esos trabajos del historial.
    try {
      const ids = JSON.parse(window.localStorage.getItem(CLAVE_HISTORIAL_OCULTO) || "[]");
      return new Set(Array.isArray(ids) ? ids : []);
    } catch (error) {
      console.warn("No se pudieron leer los trabajos ocultos del historial:", error);
      return new Set();
    }
  }

  function guardarIdsHistorialOcultos(ids) {
    // Se guarda como array porque Set no se serializa directo a JSON.
    try {
      window.localStorage.setItem(CLAVE_HISTORIAL_OCULTO, JSON.stringify(Array.from(ids)));
    } catch (error) {
      console.warn("No se pudieron guardar los trabajos ocultos del historial:", error);
    }
  }

  function crearTarjetaTarea(tarea) {
    // Tarjeta visual de una sola tarea: nombre, estado, barra de progreso y accion final.
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

    const grupoInsignias = document.createElement("span");
    grupoInsignias.className = "grupo-insignias-tarea";
    grupoInsignias.append(crearInsigniaEstado(tarea.estado));

    if (tarea.worker) {
      grupoInsignias.append(crearInsigniaWorker(tarea.worker));
    }

    filaTitulo.append(texto, grupoInsignias);
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
    // Adaptador por si llega un trabajo entero en vez de tareas sueltas.
    const tareas = Array.isArray(trabajo.tareas) ? [...trabajo.tareas] : [];

    return {
      nombre_archivo: trabajo.nombre_archivo || "audio desconocido",
      estado: trabajo.estado || "pendiente",
      tareas
    };
  }

  function agruparTareasPorTrabajo(tareas) {
    // Varias tareas pueden pertenecer al mismo archivo/trabajo; aqui se juntan para la UI.
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

    return Array.from(grupos.values()).sort((a, b) => {
      return obtenerFechaTrabajo(b.tareas) - obtenerFechaTrabajo(a.tareas);
    });
  }

  function normalizarTareaCola(tarea) {
    // Normaliza campos viejos/nuevos para que el render no dependa del formato exacto de Redis.
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
      s3_bucket: tarea.s3_bucket || "",
      s3_key: tarea.s3_key || "",
      urlResultado: tarea.urlResultado || tarea.resultado || ""
    };
  }

  function estadoGrupoTrabajo(tareas) {
    // Estado resumido del trabajo completo para la insignia del encabezado.
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
    // Siempre regresamos un porcentaje seguro para la barra, aunque Redis mande texto o nada.
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
    // IDs largos sirven internamente; en pantalla con 8 caracteres alcanza para distinguir.
    return String(id || "").slice(0, 8);
  }

  function crearInsigniaEstado(estadoTarea) {
    // La clase define color; el texto mantiene el estado legible.
    const insignia = document.createElement("span");
    insignia.className = `insignia-estado ${claseEstado(estadoTarea)}`;
    insignia.textContent = etiquetaEstado(estadoTarea);

    return insignia;
  }

  function crearInsigniaWorker(worker) {
    const insignia = document.createElement("span");
    insignia.className = `insignia-worker ${claseWorkerLog(worker)}`;
    insignia.textContent = worker;

    return insignia;
  }

  function claseEstado(estadoTarea) {
    // Acepta estados en español e ingles para no romper si cambia backend/worker.
    const normalizado = String(estadoTarea || "").trim().toLowerCase();

    if (normalizado === "pendiente" || normalizado === "pending") return "pendiente";
    if (normalizado === "en proceso" || normalizado === "en_proceso" || normalizado === "running") return "en-proceso";
    if (normalizado === "completada" || normalizado === "completed") return "completada";
    if (normalizado === "error") return "error";

    return "pendiente";
  }

  function etiquetaEstado(estadoTarea) {
    // Traduce estados tecnicos a etiquetas de pantalla.
    const normalizado = String(estadoTarea || "").trim().toLowerCase();

    if (normalizado === "pending") return "pendiente";
    if (normalizado === "running" || normalizado === "en_proceso") return "en proceso";
    if (normalizado === "completed") return "completada";

    return normalizado || "pendiente";
  }

  function rellenarAccionesTarea(contenedor, tarea) {
    // La accion final aparece solo cuando la tarea ya termino.
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
    // Logs locales de interfaz; se mezclan con los logs que vienen de Redis.
    estado.logsLocales.unshift({
      origen: "interfaz",
      mensaje,
      fecha: new Date().toISOString()
    });

    estado.logsLocales = estado.logsLocales.slice(0, 30);
    renderizarLogs();
  }

  function renderizarLogs() {
    if (!elementos.listaLogs) return;

    const estabaCercaDelFinal = (
      elementos.listaLogs.scrollHeight
      - elementos.listaLogs.scrollTop
      - elementos.listaLogs.clientHeight
    ) < 32;

    const estadosWorkers = estado.workersSistema.map((worker) => ({
      worker: worker.id,
      mensaje: formatearEstadoWorker(worker),
      fecha: worker.ultima_vez,
      tipo: "estado-worker"
    }));

    const logs = [
      ...estado.logsLocales.map((log) => ({ ...log, local: true })),
      ...estado.logsSistema
    ]
      .sort((a, b) => {
        return Number(new Date(a.fecha || 0)) - Number(new Date(b.fecha || 0));
      })
      .slice(0, 100);

    elementos.listaLogs.replaceChildren();

    if (estadosWorkers.length === 0 && logs.length === 0) {
      const entrada = document.createElement("li");
      entrada.textContent = "[sistema] listo para recibir trabajos...";
      elementos.listaLogs.append(entrada);
      return;
    }

    estadosWorkers.forEach((log) => {
      elementos.listaLogs.append(crearItemLog(log));
    });

    logs.forEach((log) => {
      elementos.listaLogs.append(crearItemLog(log));
    });

    if (estabaCercaDelFinal) {
      elementos.listaLogs.scrollTop = elementos.listaLogs.scrollHeight;
    }
  }

  function crearItemLog(log) {
    const entrada = document.createElement("li");

    if (log.tipo) {
      entrada.classList.add(log.tipo);
    }

    entrada.append(crearEtiquetaLog(log), document.createTextNode(formatearMensajeLog(log)));
    return entrada;
  }

  function formatearEstadoWorker(worker) {
    const estadoWorker = worker.estado || "desconocido";
    const tareaActual = worker.tarea_actual ? ` · ${worker.tarea_actual}` : "";
    const actividad = worker.activo ? "activo" : "sin señal reciente";

    return `${estadoWorker}${tareaActual} · ${actividad}`;
  }

  function crearEtiquetaLog(log) {
    const origen = log.worker || log.origen || "sistema";
    const etiqueta = document.createElement("span");
    etiqueta.className = `etiqueta-log ${claseWorkerLog(origen)}`;
    etiqueta.textContent = origen;
    return etiqueta;
  }

  function formatearMensajeLog(log) {
    const origen = log.worker || log.origen || "sistema";
    const mensaje = log.mensaje || "";

    if (log.local && mensaje.startsWith("[")) {
      return ` ${mensaje.replace(/^\[[^\]]+\]\s*/, "")}`;
    }

    return ` ${mensaje}`;
  }

  function claseWorkerLog(origen) {
    if (origen === "interfaz") return "interfaz";
    if (origen === "sistema") return "sistema";

    if (!estado.coloresWorkers.has(origen)) {
      estado.coloresWorkers.set(origen, estado.coloresWorkers.size % 8);
    }

    return `worker-${estado.coloresWorkers.get(origen)}`;
  }

  async function limpiarRegistros() {
    // Limpia la consola visual y tambien la lista logs:sistema de Redis.
    estado.logsLocales = [];
    estado.logsSistema = [];
    renderizarLogs();

    try {
      const respuesta = await fetch(`${URL_API}/logs`, {
        method: "DELETE"
      });

      if (!respuesta.ok) {
        throw new Error(`DELETE /logs respondió ${respuesta.status}`);
      }
    } catch (error) {
      console.error(error);
      agregarLog(`[error] no se pudieron limpiar los registros: ${error.message}`);
      return;
    }

    await cargarEstadoSistema();
  }

  function formatearBytes(bytes) {
    // Formato compacto para la ficha del archivo seleccionado.
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
    // El reproductor entrega segundos; la UI muestra mm:ss.
    if (!Number.isFinite(segundos)) {
      return "00:00";
    }

    const minutos = Math.floor(segundos / 60);
    const segundosRestantes = Math.floor(segundos % 60);

    return `${String(minutos).padStart(2, "0")}:${String(segundosRestantes).padStart(2, "0")}`;
  }

  function formatearFecha(marcaTiempo) {
    // Redis usa segundos; si algun dato llega en milisegundos tambien lo aceptamos.
    const valor = Number(marcaTiempo);

    if (!Number.isFinite(valor)) {
      return "fecha desconocida";
    }

    const fecha = new Date(valor > 10_000_000_000 ? valor : valor * 1000);

    if (Number.isNaN(fecha.getTime())) {
      return "fecha desconocida";
    }

    return new Intl.DateTimeFormat("es-MX", {
      dateStyle: "short",
      timeStyle: "short"
    }).format(fecha);
  }

  return {
    iniciar
  };
})();

AudioLab.iniciar();
