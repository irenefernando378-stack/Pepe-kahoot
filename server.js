
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

const port = Number(process.env.PORT || 3000);
const rooms = new Map();

const id = () => crypto.randomBytes(12).toString('hex');

const languages = ['it', 'sv', 'en'];

function validLanguage(lang) {
  return languages.includes(lang) ? lang : 'it';
}

function questionCount() {
  return questions.it.length;
}

function getQuestion(lang, index) {
  const selected = questions[validLanguage(lang)];

  if (selected && selected[index]) {
    return selected[index];
  }

  return questions.it[index];
}

function publicState(r, lang = 'it') {
  const selectedLang = validLanguage(lang);
  const q = getQuestion(selectedLang, r.index);
  const counts = [0, 0, 0, 0];

  for (const p of r.teams.values()) {
    if (p.answer !== null) {
      counts[p.answer]++;
    }
  }

  return {
    pin: r.pin,
    lang: selectedLang,
    phase: r.phase,
    index: r.index,
    total: questionCount(),

    teams: [...r.teams.values()].map(p => ({
      name: p.name,
      score: p.score,
      answered: p.answer !== null
    })),

    question:
      r.phase === 'lobby' || r.phase === 'end'
        ? null
        : {
            q: q.q,
            a: q.a
          },

    counts: r.phase === 'results' ? counts : null,

    correct:
      r.phase === 'results'
        ? questions.it[r.index].c
        : null,

    deadline: r.deadline,

    answered: [...r.teams.values()].filter(
      p => p.answer !== null
    ).length
  };
}

function send(r) {
  for (const client of r.clients) {
    try {
      const data = publicState(r, client.lang);
      client.res.write(
        'data: ' + JSON.stringify(data) + '\n\n'
      );
    } catch (e) {
      // Il client potrebbe essersi disconnesso.
    }
  }
}

function respond(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';

    req.on('data', chunk => {
      s += chunk;

      if (s.length > 10000) {
        reject(Error('Too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch (e) {
        reject(Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function room(pin) {
  const r = rooms.get(String(pin));

  if (!r) {
    throw Error('Partita non trovata');
  }

  return r;
}

function auth(r, token) {
  if (r.host !== token) {
    throw Error('Solo il presentatore può farlo');
  }
}

function finishQuestion(r) {
  if (r.phase !== 'question') {
    return;
  }

  clearTimeout(r.timer);
  r.phase = 'results';

  // La risposta corretta è uguale in tutte le lingue.
  const q = questions.it[r.index];

  for (const p of r.teams.values()) {
    if (p.answer === q.c) {
      const elapsed = Math.max(
        0,
        Math.min(
          r.duration,
          (p.answeredAt || Date.now()) - r.started
        )
      );

      p.score += Math.round(
        500 + 500 * (1 - elapsed / r.duration)
      );
    }
  }

  send(r);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    // CONNESSIONE IN TEMPO REALE
    if (
      req.method === 'GET' &&
      u.pathname === '/events'
    ) {
      const r = room(u.searchParams.get('pin'));

      const clientLang = validLanguage(
        u.searchParams.get('lang')
      );

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });

      const client = {
        res: res,
        lang: clientLang
      };

      r.clients.add(client);

      res.write(
        'data: ' +
        JSON.stringify(publicState(r, client.lang)) +
        '\n\n'
      );

      const interval = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch (e) {
          // Connessione chiusa.
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(interval);
        r.clients.delete(client);
      });

      return;
    }

    // API DEL GIOCO
    if (req.method === 'POST') {
      const b = await body(req);

      // CREA PARTITA
      if (u.pathname === '/api/create') {
        let pin;

        do {
          pin = String(
            100000 + Math.floor(Math.random() * 900000)
          );
        } while (rooms.has(pin));

        const r = {
          pin,
          host: id(),
          phase: 'lobby',
          index: 0,
          teams: new Map(),
          clients: new Set(),
          deadline: null,
          duration: 20000,
          timer: null
        };

        rooms.set(pin, r);

        return respond(res, 200, {
          pin,
          token: r.host
        });
      }

      // ENTRA COME SQUADRA
      if (u.pathname === '/api/join') {
        const r = room(b.pin);

        if (r.phase !== 'lobby') {
          throw Error('La partita è già iniziata');
        }

        const name = String(b.name || '')
          .trim()
          .slice(0, 32);

        if (!name) {
          throw Error('Inserisci un nome');
        }

        if (
          [...r.teams.values()].some(
            t => t.name.toLowerCase() === name.toLowerCase()
          )
        ) {
          throw Error('Nome già utilizzato');
        }

        const token = id();

        r.teams.set(token, {
          name,
          score: 0,
          answer: null,
          answeredAt: null
        });

        send(r);

        return respond(res, 200, {
          token,
          pin: r.pin,
          name
        });
      }

      // INVIA RISPOSTA
      if (u.pathname === '/api/answer') {
        const r = room(b.pin);
        const p = r.teams.get(b.token);

        if (!p) {
          throw Error('Squadra non trovata');
        }

        if (
          r.phase !== 'question' ||
          Date.now() > r.deadline
        ) {
          throw Error('Tempo scaduto');
        }

        if (p.answer !== null) {
          throw Error('Risposta già inviata');
        }

        if (
          !Number.isInteger(b.answer) ||
          b.answer < 0 ||
          b.answer > 3
        ) {
          throw Error('Risposta non valida');
        }

        p.answer = b.answer;
        p.answeredAt = Date.now();

        send(r);

        if (
          [...r.teams.values()].every(
            t => t.answer !== null
          )
        ) {
          finishQuestion(r);
        }

        return respond(res, 200, { ok: true });
      }

      // COMANDI DEL PRESENTATORE
      if (u.pathname === '/api/control') {
        const r = room(b.pin);

        auth(r, b.token);

        if (
          b.action === 'start' &&
          r.phase === 'lobby'
        ) {
          if (!r.teams.size) {
            throw Error('Attendi almeno una squadra');
          }

          r.phase = 'question';

          r.duration = Math.max(
            5000,
            Math.min(
              120000,
              Number(b.duration) || 20000
            )
          );

          r.started = Date.now();
          r.deadline = r.started + r.duration;

          r.timer = setTimeout(
            () => finishQuestion(r),
            r.duration
          );

          send(r);

        } else if (
          b.action === 'reveal' &&
          r.phase === 'question'
        ) {
          finishQuestion(r);

        } else if (
          b.action === 'next' &&
          r.phase === 'results'
        ) {
          r.index++;

          if (r.index >= questionCount()) {
            r.phase = 'end';
            r.deadline = null;

          } else {
            r.phase = 'question';

            for (const p of r.teams.values()) {
              p.answer = null;
              p.answeredAt = null;
            }

            r.started = Date.now();
            r.deadline = r.started + r.duration;

            r.timer = setTimeout(
              () => finishQuestion(r),
              r.duration
            );
          }

          send(r);

        } else if (b.action === 'restart') {
          clearTimeout(r.timer);

          r.phase = 'lobby';
          r.index = 0;
          r.deadline = null;

          for (const p of r.teams.values()) {
            p.score = 0;
            p.answer = null;
            p.answeredAt = null;
          }

          send(r);

        } else {
          throw Error('Azione non disponibile');
        }

        return respond(res, 200, { ok: true });
      }
    }

    // FILE DEL SITO
    const file =
      u.pathname === '/'
        ? 'index.html'
        : u.pathname.slice(1);

    if (!['index.html', 'questions.json'].includes(file)) {
      res.writeHead(404);
      return res.end('Not found');
    }

    res.writeHead(200, {
      'Content-Type': file.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/html; charset=utf-8'
    });

    return fs
      .createReadStream(path.join(__dirname, file))
      .pipe(res);

  } catch (e) {
    if (!res.headersSent) {
      respond(res, 400, {
        error: e.message
      });
    }
  }
});

server.listen(
  port,
  '0.0.0.0',
  () => console.log(
    'PEPE quiz http://localhost:' + port
  )
);
