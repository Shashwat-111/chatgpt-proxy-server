import express from 'express';
import { WebSocketServer } from 'ws';
import mongoose from 'mongoose';
import OpenAI from 'openai';
import { config } from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';

config();

mongoose.connect(process.env.MONGO_URI, { dbName: 'chatdb' })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB error', err));

// Chat Schema
const chatSchema = new mongoose.Schema({
  title: String,
  messages: [
    {
      role: String,
      content: String,
      imageUrl: { type: String, default: null },
    },
  ],
}, { timestamps: true });

const Chat = mongoose.model('Chat', chatSchema);

// OpenAI Config
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Upload Image API
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

// Fetch all chat previews
app.get('/api/chats', async (req, res) => {
  const chats = await Chat.find().select('title createdAt').sort({ createdAt: -1 });
  res.json(chats);
});

// Fetch full chat by ID
app.get('/api/chats/:id', async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    res.json(chat);
  } catch (e) {
    res.status(500).json({ error: 'Invalid ID' });
  }
});

// Start HTTP Server
const server = app.listen(PORT, () => console.log(`🚀 HTTP server running on port ${PORT}`));
const wss = new WebSocketServer({ server });

// WebSocket for chat
wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      const { prompt, imageUrl, history, chatId } = data;

      let messages = history.map((msg) => {
        if (msg.imageUrl) {
          return {
            role: msg.role,
            content: [
              { type: 'text', text: msg.content },
              { type: 'image_url', image_url: { url: msg.imageUrl } },
            ],
          };
        } else {
          return { role: msg.role, content: msg.content };
        }
      });

      // Add new user message
      messages.push(
        imageUrl
          ? {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            }
          : { role: 'user', content: prompt }
      );

      const stream = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        stream: true,
      });

      let collectedText = '';

      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content;
        if (token) {
          collectedText += token;
          ws.send(token);
        }
      }

      ws.send('[END]');

      // Store to DB
      let chat;
      if (chatId) {
        // if its an existing chat, append
        chat = await Chat.findById(chatId);
        if (chat) {
          chat.messages.push(
            { role: 'user', content: prompt, imageUrl },
            { role: 'assistant', content: collectedText, imageUrl: null }
          );
          await chat.save();
        }
      } else {
        // New chat
        chat = await Chat.create({
          title: prompt.slice(0, 30),
          messages: [
            { role: 'user', content: prompt, imageUrl },
            { role: 'assistant', content: collectedText, imageUrl: null },
          ],
        });
      }

      // Send back chatId (on first creation or reuse)
      ws.send(JSON.stringify({ chatId: chat._id.toString(), done: true }));

    } catch (err) {
      console.error('❌ Error handling message:', err);
      ws.send('[ERROR]');
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});
