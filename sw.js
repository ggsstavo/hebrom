/* ═══════════════════════════════════════════════════════════════
   SERVICE WORKER — Hebrom Rancho
   
   Versão do cache: mude CACHE_VERSION quando fizer deploy
   de novas versões do site. Isso descarta o cache antigo
   e força o download dos arquivos atualizados.
═══════════════════════════════════════════════════════════════ */
const CACHE_VERSION  = 'hebrom-v1';

/* Cache separado para imagens (controlamos tamanho/expiração) */
const CACHE_IMAGES   = 'hebrom-images-v1';

/* Recursos essenciais para cachear imediatamente no install */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  /* Se tiver style.css externo, adicione aqui:
     './style.css', */
];

/* ── Limites para o cache de imagens ─────────────────────── */
const IMG_CACHE_LIMIT   = 60;   // máximo de imagens armazenadas
const IMG_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 dias em ms

/* ───────────────────────────────────────────────────────────
   INSTALL — pré-cacheia os assets essenciais
   skipWaiting() ativa o SW imediatamente sem esperar
   todas as abas fecharem
─────────────────────────────────────────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

/* ───────────────────────────────────────────────────────────
   ACTIVATE — limpa caches de versões antigas
─────────────────────────────────────────────────────────── */
self.addEventListener('activate', event => {
  const KEEP = [CACHE_VERSION, CACHE_IMAGES];
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim(); // assume controle imediato de todas as abas
});

/* ───────────────────────────────────────────────────────────
   FETCH — intercepta todas as requisições de rede
─────────────────────────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignora requisições que não sejam GET */
  if (request.method !== 'GET') return;

  /* ── Google Maps embed → Network Only ──────────────────
     Não faz sentido cachear mapa interativo — sempre busca
     da rede, sem fallback                                  */
  if (url.hostname.includes('google.com/maps') ||
      url.hostname.includes('maps.googleapis.com')) {
    return; // deixa o browser resolver normalmente
  }

  /* ── Imagens → Cache First ─────────────────────────────
     Serve do cache instantaneamente; baixa da rede só na
     primeira vez ou quando o cache expirou               */
  if (request.destination === 'image') {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  /* ── HTML da página → Network First ───────────────────
     Tenta buscar versão nova da rede; se offline ou lento,
     serve o cache                                         */
  if (request.destination === 'document' ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/') {
    event.respondWith(networkFirst(request, CACHE_VERSION));
    return;
  }

  /* ── CSS, JS, fontes, ícones → Cache First ────────────
     Recursos estáticos raramente mudam; servir do cache
     é instantâneo. Quando mudam, basta atualizar
     CACHE_VERSION para descartar o cache antigo          */
  if (
    request.destination === 'style'  ||
    request.destination === 'script' ||
    request.destination === 'font'   ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')    ||
    url.hostname.includes('fontawesome.com')      ||
    url.hostname.includes('kit.fontawesome.com')
  ) {
    event.respondWith(cacheFirst(request, CACHE_VERSION));
    return;
  }

  /* ── Tudo o mais → Network First ──────────────────── */
  event.respondWith(networkFirst(request, CACHE_VERSION));
});

/* ═══════════════════════════════════════════════════════════
   ESTRATÉGIAS
═══════════════════════════════════════════════════════════ */

/* Cache First — serve do cache; baixa da rede se não tiver */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

/* Network First — tenta rede; cai no cache se falhar */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/* Cache First para imagens — com limite de entradas e TTL */
async function cacheFirstImage(request) {
  const cache  = await caches.open(CACHE_IMAGES);
  const cached = await cache.match(request);

  /* Verifica se ainda está dentro do TTL de 30 dias */
  if (cached) {
    const dateHeader = cached.headers.get('sw-cached-at');
    if (dateHeader) {
      const age = Date.now() - Number(dateHeader);
      if (age < IMG_CACHE_MAX_AGE) return cached; // ainda válido
    } else {
      return cached; // sem header de data → aceita mesmo assim
    }
  }

  /* Busca da rede e armazena com timestamp */
  try {
    const response = await fetch(request);
    if (!response.ok) return response;

    /* Clona os headers para adicionar o timestamp */
    const headers  = new Headers(response.headers);
    headers.set('sw-cached-at', String(Date.now()));
    const blob     = await response.blob();
    const stamped  = new Response(blob, { status: response.status, headers });

    /* Armazena e limpa entradas antigas se passou do limite */
    await cache.put(request, stamped.clone());
    await trimCache(cache, IMG_CACHE_LIMIT);

    return stamped;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

/* Remove as entradas mais antigas quando o cache passa do limite */
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(k => cache.delete(k)));
}
