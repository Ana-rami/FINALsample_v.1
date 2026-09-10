const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const wav = require('node-wav');
const MusicTempo = require('music-tempo');
const Meyda = require('meyda');
const mm = require('music-metadata');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = 'users.json';

app.use(express.json());
app.use(session({
  // Para uso personal en tu ordenador esto está bien.
  // Si algún día publicas esta app en internet para que otros la usen,
  // cambia este texto por algo único y no lo compartas con nadie.
  secret: 'finalsample-v1-clave-local-cambiame-si-publicas',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // la sesión dura 30 días
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(ensureIdentity);

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// Todo el mundo tiene una "identidad": si no ha iniciado sesión,
// se le asigna un id de invitado guardado en su cookie de sesión.
// Así puede usar la app sin cuenta, pero sus samples quedan ligados a ese navegador.
function ensureIdentity(req, res, next) {
  if (!req.session.userId && !req.session.guestId) {
    req.session.guestId = 'guest_' + crypto.randomBytes(8).toString('hex');
  }
  next();
}
function effectiveId(req) {
  return req.session.userId || req.session.guestId;
}

function userDir(userId) {
  return path.join(__dirname, 'uploads', userId);
}
function metadataPath(userId) {
  return path.join(userDir(userId), 'metadata.json');
}
function loadMetadata(userId) {
  try {
    return JSON.parse(fs.readFileSync(metadataPath(userId), 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveMetadata(userId, data) {
  fs.writeFileSync(metadataPath(userId), JSON.stringify(data, null, 2));
}

// ---- Cuentas ----

app.post('/register', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email y contraseña (mínimo 6 caracteres) son obligatorios' });
  }

  const users = loadUsers();
  if (users[email]) {
    return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = crypto.randomBytes(8).toString('hex');
  users[email] = { id: userId, passwordHash: passwordHash };
  saveUsers(users);

  fs.mkdirSync(userDir(userId), { recursive: true });

  // Si venía usando la app como invitado, movemos sus samples a la cuenta nueva
  const oldGuestId = req.session.guestId;
  if (oldGuestId) {
    const oldDir = userDir(oldGuestId);
    if (fs.existsSync(oldDir)) {
      const files = fs.readdirSync(oldDir);
      files.forEach(function(f) {
        fs.renameSync(path.join(oldDir, f), path.join(userDir(userId), f));
      });
      fs.rmdirSync(oldDir);
    }
  }

  req.session.userId = userId;
  delete req.session.guestId;
  req.session.email = email;
  res.json({ success: true, email: email });
});

app.post('/login', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';

  const users = loadUsers();
  const user = users[email];
  if (!user) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  req.session.userId = user.id;
  req.session.email = email;
  res.json({ success: true, email: email });
});

app.post('/logout', (req, res) => {
  req.session.destroy(function() {
    res.json({ success: true });
  });
});

app.get('/me', (req, res) => {
  if (req.session.userId) {
    res.json({ loggedIn: true, email: req.session.email });
  } else {
    res.json({ loggedIn: false });
  }
});

// ---- Samples (todo requiere sesión iniciada) ----

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = userDir(effectiveId(req));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

function analyzeBPM(channelData) {
  try {
    const mt = new MusicTempo(channelData);
    return Math.round(mt.tempo);
  } catch (e) {
    console.log('No se pudo analizar el BPM:', e.message);
    return null;
  }
}

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function correlate(a, b) {
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - meanA) * (b[i] - meanB);
    denA += (a[i] - meanA) ** 2;
    denB += (b[i] - meanB) ** 2;
  }
  return num / Math.sqrt(denA * denB || 1);
}
function rotateProfile(profile, r) {
  const rotated = new Array(12);
  for (let i = 0; i < 12; i++) rotated[i] = profile[(i - r + 12) % 12];
  return rotated;
}
function estimateKeyFromChroma(chroma) {
  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < 12; r++) {
    const majorScore = correlate(chroma, rotateProfile(MAJOR_PROFILE, r));
    const minorScore = correlate(chroma, rotateProfile(MINOR_PROFILE, r));
    if (majorScore > bestScore) { bestScore = majorScore; best = NOTE_NAMES[r] + ' mayor'; }
    if (minorScore > bestScore) { bestScore = minorScore; best = NOTE_NAMES[r] + ' menor'; }
  }
  return best;
}
function analyzeKey(channelData, sampleRate) {
  try {
    const bufferSize = 4096;
    Meyda.bufferSize = bufferSize;
    Meyda.sampleRate = sampleRate;
    const chromaSum = new Array(12).fill(0);
    let frameCount = 0;
    for (let i = 0; i + bufferSize <= channelData.length; i += bufferSize) {
      const frame = channelData.slice(i, i + bufferSize);
      const chroma = Meyda.extract('chroma', frame);
      if (chroma) {
        for (let j = 0; j < 12; j++) chromaSum[j] += chroma[j];
        frameCount++;
      }
    }
    if (frameCount === 0) return null;
    const chromaAvg = chromaSum.map(v => v / frameCount);
    return estimateKeyFromChroma(chromaAvg);
  } catch (e) {
    console.log('No se pudo analizar la tonalidad:', e.message);
    return null;
  }
}
function computeWaveformPeaks(channelData, numPeaks) {
  const peaks = [];
  const blockSize = Math.floor(channelData.length / numPeaks) || 1;
  for (let i = 0; i < numPeaks; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channelData.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += Math.abs(channelData[j]);
    const avg = end > start ? sum / (end - start) : 0;
    peaks.push(avg);
  }
  const max = Math.max.apply(null, peaks.concat([0.0001]));
  return peaks.map(function(p) { return Math.round((p / max) * 100) / 100; });
}
function convertToWav(inputPath, outputPath) {
  return new Promise(function(resolve, reject) {
    ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(44100)
      .format('wav')
      .on('end', function() { resolve(); })
      .on('error', function(err) { reject(err); })
      .save(outputPath);
  });
}

function detectType(originalName, durationSeconds) {
  const name = originalName.toLowerCase();
  if (durationSeconds && durationSeconds > 40) return 'cancion';
  if (name.includes('kick')) return 'kick';
  if (name.includes('snare')) return 'snare';
  if (name.includes('hat')) return 'hihat';
  if (name.includes('perc')) return 'percusion';
  if (name.includes('loop')) return 'loop';
  if (name.includes('808') || name.includes('bajo') || name.includes('bass')) return 'bajo';
  if (name.includes('vocal') || name.includes('vox') || name.includes('voz')) return 'vocal';
  if (name.includes('pad') || name.includes('string') || name.includes('melod') || name.includes('chord')) return 'melodico';
  return 'otros';
}

app.post('/upload', upload.single('sample'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  const metadata = loadMetadata(effectiveId(req));
  let bpm = null, key = null, duration = null, waveform = [];

  if (req.file.originalname.toLowerCase().endsWith('.wav')) {
    try {
      const buffer = fs.readFileSync(req.file.path);
      const decoded = wav.decode(buffer);
      const channelData = decoded.channelData[0];
      duration = channelData.length / decoded.sampleRate;
      bpm = analyzeBPM(channelData);
      key = analyzeKey(channelData, decoded.sampleRate);
      waveform = computeWaveformPeaks(channelData, 24);
    } catch (e) {
      console.log('Error analizando el audio:', e.message);
    }
  } else {
    // Otros formatos (mp3, ogg...): los convertimos a wav por detrás con ffmpeg
    // para poder reutilizar el mismo análisis de BPM/tonalidad/forma de onda.
    const tempWavPath = req.file.path + '.temp.wav';
    try {
      await convertToWav(req.file.path, tempWavPath);
      const buffer = fs.readFileSync(tempWavPath);
      const decoded = wav.decode(buffer);
      const channelData = decoded.channelData[0];
      duration = channelData.length / decoded.sampleRate;
      bpm = analyzeBPM(channelData);
      key = analyzeKey(channelData, decoded.sampleRate);
      waveform = computeWaveformPeaks(channelData, 24);
    } catch (e) {
      console.log('No se pudo convertir/analizar el archivo (¿ffmpeg instalado?):', e.message);
      // Si falla la conversión, al menos intentamos sacar la duración
      try {
        const info = await mm.parseFile(req.file.path);
        duration = info.format.duration || null;
      } catch (e2) {
        console.log('Tampoco se pudo leer la duración:', e2.message);
      }
    } finally {
      if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
    }
  }

  const type = detectType(req.file.originalname, duration);

  metadata[req.file.filename] = {
    bpm: bpm, key: key, duration: duration, type: type, waveform: waveform,
    favorite: false, customName: null, tags: []
  };
  saveMetadata(effectiveId(req), metadata);

  res.json({ success: true, filename: req.file.filename });
});

app.get('/samples', (req, res) => {
  const dir = userDir(effectiveId(req));
  fs.readdir(dir, (err, files) => {
    if (err) return res.json({ files: [] });

    const metadata = loadMetadata(effectiveId(req));
    const audioFiles = files.filter(f => f !== 'metadata.json');

    const result = audioFiles.map(function(f) {
      const m = metadata[f] || {};
      return {
        filename: f,
        bpm: m.bpm || null,
        key: m.key || null,
        type: m.type || 'otros',
        waveform: m.waveform || [],
        favorite: m.favorite || false,
        customName: m.customName || null,
        tags: m.tags || [],
        duration: m.duration || null
      };
    });

    res.json({ files: result });
  });
});

app.get('/uploads/:filename', (req, res) => {
  const filePath = path.join(userDir(effectiveId(req)), req.params.filename);
  res.sendFile(filePath, function(err) {
    if (err) res.status(404).send('Archivo no encontrado');
  });
});

app.delete('/samples/:filename', (req, res) => {
  const filePath = path.join(userDir(effectiveId(req)), req.params.filename);
  fs.unlink(filePath, (err) => {
    if (err) return res.status(500).json({ error: 'No se pudo borrar el archivo' });
    const metadata = loadMetadata(effectiveId(req));
    delete metadata[req.params.filename];
    saveMetadata(effectiveId(req), metadata);
    res.json({ success: true });
  });
});

app.post('/samples/:filename/favorite', (req, res) => {
  const metadata = loadMetadata(effectiveId(req));
  if (!metadata[req.params.filename]) return res.status(404).json({ error: 'No encontrado' });
  metadata[req.params.filename].favorite = !metadata[req.params.filename].favorite;
  saveMetadata(effectiveId(req), metadata);
  res.json({ success: true, favorite: metadata[req.params.filename].favorite });
});

app.patch('/samples/:filename/name', (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre vacío' });
  const metadata = loadMetadata(effectiveId(req));
  if (!metadata[req.params.filename]) return res.status(404).json({ error: 'No encontrado' });
  metadata[req.params.filename].customName = name.trim();
  saveMetadata(effectiveId(req), metadata);
  res.json({ success: true, customName: metadata[req.params.filename].customName });
});

app.patch('/samples/:filename/tags', (req, res) => {
  const tags = req.body && req.body.tags;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags debe ser un array' });
  const metadata = loadMetadata(effectiveId(req));
  if (!metadata[req.params.filename]) return res.status(404).json({ error: 'No encontrado' });
  metadata[req.params.filename].tags = tags;
  saveMetadata(effectiveId(req), metadata);
  res.json({ success: true, tags: metadata[req.params.filename].tags });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});