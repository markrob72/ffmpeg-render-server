const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(express.json({ limit: '10mb' }));

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
});

async function downloadFile(url, dest) {
  const res = await fetch(url);
  const buffer = await res.buffer();
  fs.writeFileSync(dest, buffer);
}

function generateSRT(segments) {
  return segments.map((seg, i) => {
    const fmt = ms => {
      const h = String(Math.floor(ms/3600000)).padStart(2,'0');
      const m = String(Math.floor((ms%3600000)/60000)).padStart(2,'0');
      const s = String(Math.floor((ms%60000)/1000)).padStart(2,'0');
      const ms2 = String(ms%1000).padStart(3,'0');
      return `${h}:${m}:${s},${ms2}`;
    };
    return `${i+1}\n${fmt(seg.timestamp_start*1000)} --> ${fmt(seg.timestamp_end*1000)}\n${seg.caption_text || ''}\n`;
  }).join('\n');
}

app.post('/render', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { segments, musicUrl, thumbnailTimestamp = 3 } = req.body;
  const workDir = `/tmp/render_${Date.now()}`;
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // Download assets
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.image_url && !seg.image_url.startsWith('IMAGE_')) {
        await downloadFile(seg.image_url, `${workDir}/img_${i}.jpg`);
      } else {
        // Solid color fallback frame
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input('color=c=0x1a1a2e:size=1080x1920:duration=1')
            .inputOptions(['-f lavfi'])
            .outputOptions(['-frames:v 1'])
            .output(`${workDir}/img_${i}.jpg`)
            .on('end', resolve).on('error', reject).run();
        });
      }
      if (seg.audio_url && !seg.audio_url.startsWith('AUDIO_')) {
        await downloadFile(seg.audio_url, `${workDir}/audio_${i}.mp3`);
      }
    }

    // Generate SRT
    fs.writeFileSync(`${workDir}/captions.srt`, generateSRT(segments));

    // Create segment videos
    const segVideos = [];
    for (let i = 0; i < segments.length; i++) {
      const segOut = `${workDir}/seg_${i}.mp4`;
      const duration = segments[i].duration_ms / 1000;
      const imgPath = `${workDir}/img_${i}.jpg`;
      const audioPath = fs.existsSync(`${workDir}/audio_${i}.mp3`) ? `${workDir}/audio_${i}.mp3` : null;

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg().input(imgPath).inputOptions(['-loop 1']);
        if (audioPath) cmd.input(audioPath);
        cmd.videoFilter([
          'scale=1080:1920:force_original_aspect_ratio=increase',
          'crop=1080:1920',
          `zoompan=z='min(zoom+0.0006,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${Math.round(duration*30)}:fps=30`
        ])
        .outputOptions([
          `-t ${duration}`, '-c:v libx264', '-pix_fmt yuv420p', '-r 30',
          audioPath ? '-c:a aac' : '-an', '-shortest'
        ])
        .output(segOut)
        .on('end', resolve).on('error', reject).run();
      });
      segVideos.push(segOut);
    }

    // Concatenate
    const concatList = segVideos.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(`${workDir}/concat.txt`, concatList);
    const concatOut = `${workDir}/concat.mp4`;
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(`${workDir}/concat.txt`)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(concatOut)
        .on('end', resolve).on('error', reject).run();
    });

    // Mix music
    await downloadFile(musicUrl, `${workDir}/music.mp3`);
    const withMusicOut = `${workDir}/with_music.mp4`;
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatOut).input(`${workDir}/music.mp3`)
        .complexFilter([
          '[0:a]volume=1.0[voice]',
          '[1:a]volume=0.12,afade=t=in:st=0:d=2[music]',
          '[voice][music]amix=inputs=2:duration=first[aout]'
        ])
        .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest'])
        .output(withMusicOut)
        .on('end', resolve).on('error', reject).run();
    });

    // Burn captions
    const finalOut = `${workDir}/final.mp4`;
    await new Promise((resolve, reject) => {
      ffmpeg().input(withMusicOut)
        .videoFilter(`subtitles=${workDir}/captions.srt:force_style='FontName=Impact,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Bold=1,Alignment=2,MarginV=100'`)
        .outputOptions(['-c:a copy'])
        .output(finalOut)
        .on('end', resolve).on('error', reject).run();
    });

    // Extract thumbnail
    const thumbOut = `${workDir}/thumbnail.jpg`;
    await new Promise((resolve, reject) => {
      ffmpeg().input(finalOut)
        .seekInput(thumbnailTimestamp)
        .outputOptions(['-vframes 1', '-q:v 2'])
        .output(thumbOut)
        .on('end', resolve).on('error', reject).run();
    });

    // Upload to R2
    const videoKey = `videos/${Date.now()}_final.mp4`;
    const thumbKey = `thumbnails/${Date.now()}_thumb.jpg`;

    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: videoKey,
      Body: fs.readFileSync(finalOut),
      ContentType: 'video/mp4'
    }));
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: thumbKey,
      Body: fs.readFileSync(thumbOut),
      ContentType: 'image/jpeg'
    }));

    fs.rmSync(workDir, { recursive: true });

    res.json({
      videoUrl: `${process.env.R2_PUBLIC_URL}/${videoKey}`,
      thumbnailUrl: `${process.env.R2_PUBLIC_URL}/${thumbKey}`,
      duration: segments.reduce((sum, s) => sum + s.duration_ms / 1000, 0)
    });

  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FFmpeg server running on port ${PORT}`));
