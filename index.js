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

const server = app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage); 
      const { prompt, image, history } = data;

      let imageUrl = null;

      // If image provided, upload to Cloudinary
      if (image) {
        const uploadResponse = await cloudinary.uploader.upload(`data:image/jpeg;base64,${image}`, {
          folder: 'chat-images',
        });
        imageUrl = uploadResponse.secure_url;
      }

      console.log('imageurl:', imageUrl);

      const messages = history || [];

      messages.push({
        role: 'user',
        content: imageUrl
          ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ]
          : prompt,
      });


      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        stream: true,
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
