import { WebSocketServer } from 'ws';
import express from 'express';
import { config } from 'dotenv';
import OpenAI from 'openai';
import { v2 as cloudinary } from 'cloudinary';

config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// HTTP route for uploading images
app.post('/api/upload-image', async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'Image required' });

  try {
    const uploadRes = await cloudinary.uploader.upload(`data:image/jpeg;base64,${base64}`, {
      folder: 'chat-images',
    });
    return res.json({ url: uploadRes.secure_url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

const server = app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      const { prompt, imageUrl, history } = data;

      const messages = history.map((msg) => {
        if (msg.imageUrl) {
          return {
            role: msg.role,
            content: [
              { type: 'text', text: msg.content },
              { type: 'image_url', image_url: { url: msg.imageUrl } }
            ]
          };
        } else {
          return {
            role: msg.role,
            content: msg.content
          };
        }
      });

      // Push current user prompt
      messages.push(
        imageUrl
          ? {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } }
              ]
            }
          : {
              role: 'user',
              content: prompt
            }
      );

      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        stream: true
      });

      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) ws.send(token);
      }

      ws.send('[END]');
    } catch (err) {
      console.error('Error handling message:', err);
      ws.send('[ERROR]');
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});
