import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { JwtPayload } from 'jsonwebtoken';

// --- Mock jsonwebtoken BEFORE importing the middleware ---
vi.mock('jsonwebtoken', () => ({
    default: {
        verify: vi.fn(),
    },
}));

import jwt from 'jsonwebtoken';
import auth from '../middleware/auth';
import ApiError from '../utils/apiError';

// Helper to build a minimal mock request
const mockRequest = (overrides: Partial<Request> = {}): Partial<Request> => ({
    cookies: {},
    headers: {},
    ...overrides,
});

const mockResponse = (): Partial<Response> => ({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
});

const mockNext = (): NextFunction => vi.fn();

describe('auth middleware', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls next with ApiError(401) when no token is provided', () => {
        const req = mockRequest();
        const res = mockResponse();
        const next = mockNext();

        auth(req as Request, res as Response, next);

        expect(next).toHaveBeenCalledOnce();
        const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(401);
        expect(err.message).toBe('Authorization denied, no token provided.');

        // Must NOT call res.json directly
        expect(res.json).not.toHaveBeenCalled();
    });

    it('populates req.user and calls next() with no argument when token is valid', () => {
        const fakePayload: JwtPayload = { userId: 'abc-123', iat: 1000, exp: 2000 };
        vi.mocked(jwt.verify).mockReturnValueOnce(fakePayload as any);

        const req = mockRequest({ cookies: { accessToken: 'valid.token.here' } });
        const res = mockResponse();
        const next = mockNext();

        auth(req as Request, res as Response, next);

        // Should set req.user
        expect((req as any).user).toEqual(fakePayload);

        // next() called with no arguments (success path)
        expect(next).toHaveBeenCalledOnce();
        expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeUndefined();
    });

    it('calls next with ApiError(401) when token verification fails', () => {
        vi.mocked(jwt.verify).mockImplementationOnce(() => {
            throw new Error('jwt expired');
        });

        const req = mockRequest({
            headers: { authorization: 'Bearer expired.token.here' },
        });
        const res = mockResponse();
        const next = mockNext();

        auth(req as Request, res as Response, next);

        expect(next).toHaveBeenCalledOnce();
        const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(401);
        expect(err.message).toBe('Token is not valid.');

        // Must NOT call res.json directly
        expect(res.json).not.toHaveBeenCalled();
    });
});
