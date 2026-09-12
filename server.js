require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const wav = require('node-wav');
const MusicTempo = require('music-tempo');
const Meyda = require('meyda');
const mm = require('music-metadata');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'cambia-esto-en-produccion';
const BUCKET = 'samples';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Identidad: cuenta real (JWT) o invitado (cookie simple) ----

function ensureIdentity(req, res, next) {
  const token = req.cookies.auth_token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.userId;
      req.userEmail = payload.email;
      return next();
    } catch (e) {
      // token inválido o caducado, seguimos como invitado
    }
  }

  if (!req.cookies.guest_id) {
    const guestId = 'guest_' + crypto.randomBytes(8).toString('hex');
    res.cookie('guest_id', guestId, { maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true });
    req.guestId = guestId;
  } else {
    req.guestId = req.cookies.guest_id;
  }
  next();
}
app.use(ensureIdentity);

function effectiveId(req) {
  return req.userId || req.guestId;
}

// ---- Cuentas ----

app.post('/register', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email y contraseña (mínimo 6 caracteres) son obligatorios' });
  }

  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) {
    return res.status(400).json({ error: 'Ya existe una cuenta con ese email' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = crypto.randomBytes(8).toString('hex');

  const { error } = await supabase.from('users').insert({ id: userId, email: email, password_hash: passwordHash });
  if (error) {
    console.log('Error creando usuario:', error.message);
    return res.status(500).json({ error: 'No se pudo crear la cuenta' });
  }

  // Si venía como invitado, sus samples pasan a pertenecer a la cuenta nueva
  const oldGuestId = req.guestId;
  if (oldGuestId) {
    await supabase.from('samples').update({ owner_id: userId }).eq('owner_id', oldGuestId);
  }

  const token = jwt.sign({ userId: userId, email: email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('auth_token', token, { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true });
  res.clearCookie('guest_id');
  res.json({ success: true, email: email });
});

app.post('/login', async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = (req.body && req.body.password) || '';

  const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
  if (!user) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(400).json({ error: 'Email o contraseña incorrectos' });
  }

  const token = jwt.sign({ userId: user.id, email: email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('auth_token', token, { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true });
  res.json({ success: true, email: email });
});

app.post('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ success: true });
});

app.get('/me', (req, res) => {
  if (req.userId) {
    res.json({ loggedIn: true, email: req.userEmail });
  } else {
    res.json({ loggedIn: false });
  }
});

// ---- Análisis de audio (igual que antes) ----

const upload = multer({ storage: multer.memoryStorage() });

function analyzeBPM(channelData) {
  try {
    const mt = new MusicTempo(channelData);
    return Math.round(mt.tempo);
  } catch (e) {
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
  let best = null, bestScore = -Infinity;
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
    peaks.push(end > start ? sum / (end - start) : 0);
  }
  const max = Math.max.apply(null, peaks.concat([0.0001]));
  return peaks.map(function(p) { return Math.round((p / max) * 100) / 100; });
}
function convertToWav(inputPath, outputPath) {
  return new Promise(function(resolve, reject) {
    ffmpeg(inputPath).noVideo().audioChannels(1).audioFrequency(44100).format('wav')
      .on('end', resolve).on('error', reject).save(outputPath);
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

// ---- Samples ----

app.post('/upload', upload.single('sample'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

  let bpm = null, key = null, duration = null, waveform = [];
  const isWav = req.file.originalname.toLowerCase().endsWith('.wav');

  if (isWav) {
    try {
      const decoded = wav.decode(req.file.buffer);
      const channelData = decoded.channelData[0];
      duration = channelData.length / decoded.sampleRate;
      waveform = computeWaveformPeaks(channelData, 24);
      bpm = analyzeBPM(channelData);
      key = analyzeKey(channelData, decoded.sampleRate);
    } catch (e) {
      console.log('Error analizando wav:', e.message);
    }
  } else {
    const tempIn = path.join(os.tmpdir(), crypto.randomBytes(6).toString('hex') + '-' + req.file.originalname);
    const tempWav = tempIn + '.wav';
    try {
      fs.writeFileSync(tempIn, req.file.buffer);
      await convertToWav(tempIn, tempWav);
      const decoded = wav.decode(fs.readFileSync(tempWav));
      const channelData = decoded.channelData[0];
      duration = channelData.length / decoded.sampleRate;
      waveform = computeWaveformPeaks(channelData, 24);
      bpm = analyzeBPM(channelData);
      key = analyzeKey(channelData, decoded.sampleRate);
    } catch (e) {
      console.log('No se pudo convertir/analizar:', e.message);
      try {
        const info = await mm.parseBuffer(req.file.buffer, req.file.mimetype);
        duration = info.format.duration || null;
      } catch (e2) {}
    } finally {
      if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
      if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
    }
  }

  const type = detectType(req.file.originalname, duration);
  const ownerId = effectiveId(req);
  const sampleId = crypto.randomBytes(8).toString('hex');
  const storagePath = ownerId + '/' + sampleId + '-' + req.file.originalname;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, req.file.buffer, {
    contentType: req.file.mimetype
  });
  if (uploadError) {
    console.log('Error subiendo a Storage:', uploadError.message);
    return res.status(500).json({ error: 'No se pudo guardar el archivo' });
  }

  const { error: dbError } = await supabase.from('samples').insert({
    id: sampleId,
    owner_id: ownerId,
    storage_path: storagePath,
    original_name: req.file.originalname,
    bpm: bpm, key: key, duration: duration, type: type,
    waveform: waveform, favorite: false, custom_name: null, tags: []
  });
  if (dbError) {
    console.log('Error guardando en la base de datos:', dbError.message);
    return res.status(500).json({ error: 'No se pudo guardar la información del archivo' });
  }

  res.json({ success: true });
});

app.get('/samples', async (req, res) => {
  const { data, error } = await supabase
    .from('samples')
    .select('*')
    .eq('owner_id', effectiveId(req))
    .order('created_at', { ascending: true });

  if (error) return res.json({ files: [] });

  const files = data.map(function(row) {
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(row.storage_path);
    return {
      id: row.id,
      url: urlData.publicUrl,
      originalName: row.original_name,
      bpm: row.bpm,
      key: row.key,
      type: row.type,
      waveform: row.waveform || [],
      favorite: row.favorite,
      customName: row.custom_name,
      tags: row.tags || [],
      duration: row.duration
    };
  });

  res.json({ files: files });
});

app.delete('/samples/:id', async (req, res) => {
  const ownerId = effectiveId(req);
  const { data: row } = await supabase.from('samples').select('storage_path').eq('id', req.params.id).eq('owner_id', ownerId).maybeSingle();
  if (!row) return res.status(404).json({ error: 'No encontrado' });

  await supabase.storage.from(BUCKET).remove([row.storage_path]);
  await supabase.from('samples').delete().eq('id', req.params.id).eq('owner_id', ownerId);
  res.json({ success: true });
});

app.post('/samples/:id/favorite', async (req, res) => {
  const ownerId = effectiveId(req);
  const { data: row } = await supabase.from('samples').select('favorite').eq('id', req.params.id).eq('owner_id', ownerId).maybeSingle();
  if (!row) return res.status(404).json({ error: 'No encontrado' });

  const newValue = !row.favorite;
  await supabase.from('samples').update({ favorite: newValue }).eq('id', req.params.id).eq('owner_id', ownerId);
  res.json({ success: true, favorite: newValue });
});

app.patch('/samples/:id/name', async (req, res) => {
  const name = req.body && req.body.name;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre vacío' });

  const ownerId = effectiveId(req);
  await supabase.from('samples').update({ custom_name: name.trim() }).eq('id', req.params.id).eq('owner_id', ownerId);
  res.json({ success: true, customName: name.trim() });
});

app.patch('/samples/:id/tags', async (req, res) => {
  const tags = req.body && req.body.tags;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags debe ser un array' });

  const ownerId = effectiveId(req);
  await supabase.from('samples').update({ tags: tags }).eq('id', req.params.id).eq('owner_id', ownerId);
  res.json({ success: true, tags: tags });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});