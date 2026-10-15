// Tu propio servidor: sirve los archivos de este directorio (como servir.mjs de deploy) y
// además guarda las preguntas de quien visita, para que todos vean la misma lista.
// Las preguntas viven en .preguntas.json (con punto: nunca sale a internet como archivo).
//   node servidor.mjs        (PUERTO cambia el puerto, para las pruebas)
//
//   GET  /api/preguntas              la lista, primero las más votadas
//   POST /api/preguntas              { "texto": "..." } guarda una pregunta nueva
//   POST /api/preguntas/<id>/votar   suma un voto
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const raiz = import.meta.dirname;
const puerto = Number(process.env.PUERTO ?? 3000);
const DATOS = join(raiz, '.preguntas.json');
const MAX_TEXTO = 500;
const MAX_CUERPO = 2048;

// Solo estos tipos salen a internet: servidor.mjs y los demás no se sirven.
const TIPOS = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon'
};

const hora = new Intl.DateTimeFormat('es-MX', {
	timeZone: 'America/Mexico_City',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23'
});

/** De dónde viene la visita, en una palabra: lo que se reconoce en la bitácora. */
function aparato(ua = '') {
	if (ua.startsWith('deploy')) return 'deploy (prueba)';
	if (/curl/i.test(ua)) return 'curl';
	for (const [patron, nombre] of [
		[/iPhone/, 'iPhone'],
		[/iPad/, 'iPad'],
		[/Android/, 'Android'],
		[/Macintosh/, 'Mac'],
		[/Windows/, 'Windows'],
		[/CrOS/, 'Chromebook'],
		[/Linux/, 'Linux']
	])
		if (patron.test(ua)) return nombre;
	return 'otro';
}

/** El archivo que pide la URL, o null si se sale del directorio, es oculto o no es de un tipo conocido. */
function archivoDe(camino) {
	const archivo = normalize(join(raiz, camino.endsWith('/') ? `${camino}index.html` : camino));
	if (!archivo.startsWith(raiz + sep)) return null;
	const oculto = archivo
		.slice(raiz.length)
		.split(sep)
		.some((parte) => parte.startsWith('.'));
	if (oculto || !TIPOS[extname(archivo).toLowerCase()]) return null;
	return archivo;
}

// Las preguntas se leen una vez al arrancar y se guardan en el disco en cada cambio.
let preguntas = [];
try {
	preguntas = JSON.parse(readFileSync(DATOS, 'utf8'));
} catch (e) {
	if (e.code !== 'ENOENT') {
		console.error(`No pude leer ${DATOS}: ${e.message}`);
		process.exit(1);
	}
}

// Una escritura a la vez: primero a un archivo aparte y luego se renombra, así nunca queda a medias.
let guardando = Promise.resolve();
function guardar() {
	guardando = guardando.then(async () => {
		const temporal = `${DATOS}.tmp`;
		await writeFile(temporal, JSON.stringify(preguntas, null, '\t'));
		await rename(temporal, DATOS);
	});
	return guardando;
}

class ErrorHttp extends Error {
	constructor(codigo, mensaje) {
		super(mensaje);
		this.codigo = codigo;
	}
}

function leerJson(req) {
	return new Promise((resolver, fallar) => {
		let cuerpo = '';
		let demasiado = false;
		req.setEncoding('utf8');
		req.on('data', (parte) => {
			if (demasiado) return;
			cuerpo += parte;
			if (cuerpo.length > MAX_CUERPO) {
				// Se deja de guardar, pero se termina de leer para poder responder.
				demasiado = true;
				cuerpo = '';
				fallar(new ErrorHttp(413, 'La solicitud es demasiado grande.'));
			}
		});
		req.on('end', () => {
			if (demasiado) return;
			try {
				resolver(JSON.parse(cuerpo));
			} catch {
				fallar(new ErrorHttp(400, 'La solicitud no es JSON válido.'));
			}
		});
		req.on('error', fallar);
	});
}

const ordenadas = () =>
	[...preguntas].sort((a, b) => b.votos - a.votos || a.fecha.localeCompare(b.fecha));

/** Responde la API. Devuelve [código, datos]; los errores salen como ErrorHttp. */
async function api(req, camino) {
	if (camino === '/api/preguntas') {
		if (req.method === 'GET') return [200, ordenadas()];
		if (req.method === 'POST') {
			const { texto } = (await leerJson(req)) ?? {};
			const limpio = typeof texto === 'string' ? texto.trim() : '';
			if (!limpio) throw new ErrorHttp(400, 'Escribe tu pregunta antes de enviarla.');
			if (limpio.length > MAX_TEXTO)
				throw new ErrorHttp(400, `La pregunta pasa de ${MAX_TEXTO} caracteres.`);
			const pregunta = { id: randomUUID(), texto: limpio, votos: 0, fecha: new Date().toISOString() };
			preguntas.push(pregunta);
			await guardar();
			return [201, pregunta];
		}
		throw new ErrorHttp(405, 'Método no permitido.');
	}
	const voto = camino.match(/^\/api\/preguntas\/([^/]+)\/votar$/);
	if (voto) {
		if (req.method !== 'POST') throw new ErrorHttp(405, 'Método no permitido.');
		const pregunta = preguntas.find((p) => p.id === voto[1]);
		if (!pregunta) throw new ErrorHttp(404, 'Esa pregunta no existe.');
		pregunta.votos += 1;
		await guardar();
		return [200, pregunta];
	}
	throw new ErrorHttp(404, 'No existe.');
}

const servidor = createServer(async (req, res) => {
	let codigo = 200;
	try {
		const camino = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		if (camino.startsWith('/api/')) {
			let datos;
			try {
				[codigo, datos] = await api(req, camino);
			} catch (e) {
				codigo = e instanceof ErrorHttp ? e.codigo : 500;
				datos = { error: e instanceof ErrorHttp ? e.message : 'Algo falló en el servidor.' };
				if (codigo === 500) console.error(e);
			}
			res.writeHead(codigo, {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store'
			});
			res.end(JSON.stringify(datos));
		} else {
			const archivo = archivoDe(camino);
			if (!archivo) codigo = 404;
			else {
				const cuerpo = await readFile(archivo);
				res.writeHead(200, {
					'content-type': TIPOS[extname(archivo).toLowerCase()],
					'cache-control': 'no-store'
				});
				res.end(req.method === 'HEAD' ? undefined : cuerpo);
			}
		}
	} catch (e) {
		codigo = e instanceof URIError ? 400 : 404;
	}
	if (!res.headersSent) {
		res.writeHead(codigo, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(codigo === 404 ? 'No existe.\n' : 'Dirección mal escrita.\n');
	}
	console.log(
		`${hora.format(new Date())}  ${req.method} ${req.url}  ${codigo}  ${aparato(req.headers['user-agent'])}`
	);
});

servidor.on('error', (e) => {
	console.error(
		e.code === 'EADDRINUSE'
			? `El puerto ${puerto} ya está ocupado por otro proceso.`
			: `No pude escuchar en el puerto ${puerto}: ${e.message}`
	);
	process.exit(1);
});
servidor.listen(puerto, '0.0.0.0', () =>
	console.log(`${hora.format(new Date())}  escuchando en el puerto ${puerto}: ${raiz} (con preguntas)`)
);
