import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
    process.env.ACCESS_TOKEN_SECRET = 'test_access_secret';
    process.env.REFRESH_TOKEN_SECRET = 'test_refresh_secret';
});

import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt';
import jwt from 'jsonwebtoken';

describe('jwt utility', () => {
    const userId = 'user-123';

    it('generates a valid access token', () => {
        const token = generateAccessToken(userId);
        expect(token).toBeDefined();
        const decoded = jwt.decode(token) as any;
        expect(decoded.userId).toBe(userId);
    });

    it('generates a valid refresh token', () => {
        const token = generateRefreshToken(userId);
        expect(token).toBeDefined();
        const decoded = jwt.decode(token) as any;
        expect(decoded.userId).toBe(userId);
    });

    it('verifies a valid access token', () => {
        const token = generateAccessToken(userId);
        const verified = verifyAccessToken(token);
        expect(verified.userId).toBe(userId);
    });

    it('verifies a valid refresh token', () => {
        const token = generateRefreshToken(userId);
        const verified = verifyRefreshToken(token) as any;
        expect(verified.userId).toBe(userId);
    });

    it('throws error for invalid access token', () => {
        expect(() => verifyAccessToken('invalid.token')).toThrow();
    });
});
