import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'catan-legends-secret-key-change-in-prod';

interface AuthResult {
  success: boolean;
  token?: string;
  user?: { id: string; username: string; wins: number; losses: number; elo: number };
  error?: string;
}

export async function register(prisma: PrismaClient, username: string, password: string): Promise<AuthResult> {
  if (!username || username.length < 3) return { success: false, error: 'Username must be at least 3 characters' };
  if (!password || password.length < 4) return { success: false, error: 'Password must be at least 4 characters' };
  if (username.length > 20) return { success: false, error: 'Username max 20 characters' };

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return { success: false, error: 'Username already taken' };

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { username, password: hash }
  });

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

  return {
    success: true,
    token,
    user: { id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo }
  };
}

export async function login(prisma: PrismaClient, username: string, password: string): Promise<AuthResult> {
  if (!username || !password) return { success: false, error: 'Username and password required' };

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return { success: false, error: 'User not found' };

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return { success: false, error: 'Wrong password' };

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

  return {
    success: true,
    token,
    user: { id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo }
  };
}

export function verifyToken(token: string): { userId: string; username: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { userId: string; username: string };
  } catch {
    return null;
  }
}
