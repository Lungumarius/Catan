"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.login = login;
exports.verifyToken = verifyToken;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'catan-legends-secret-key-change-in-prod';
async function register(prisma, username, password) {
    if (!username || username.length < 3)
        return { success: false, error: 'Username must be at least 3 characters' };
    if (!password || password.length < 4)
        return { success: false, error: 'Password must be at least 4 characters' };
    if (username.length > 20)
        return { success: false, error: 'Username max 20 characters' };
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing)
        return { success: false, error: 'Username already taken' };
    const hash = await bcryptjs_1.default.hash(password, 10);
    const user = await prisma.user.create({
        data: { username, password: hash }
    });
    const token = jsonwebtoken_1.default.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    return {
        success: true,
        token,
        user: { id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo }
    };
}
async function login(prisma, username, password) {
    if (!username || !password)
        return { success: false, error: 'Username and password required' };
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user)
        return { success: false, error: 'User not found' };
    const valid = await bcryptjs_1.default.compare(password, user.password);
    if (!valid)
        return { success: false, error: 'Wrong password' };
    const token = jsonwebtoken_1.default.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    return {
        success: true,
        token,
        user: { id: user.id, username: user.username, wins: user.wins, losses: user.losses, elo: user.elo }
    };
}
function verifyToken(token) {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch {
        return null;
    }
}
