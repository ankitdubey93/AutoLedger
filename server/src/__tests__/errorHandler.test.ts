import { describe, it, expect, vi } from 'vitest';
import errorHandler from '../middleware/errorHandler';
import ApiError from '../utils/apiError';
import { Request, Response, NextFunction } from 'express';

describe('errorHandler middleware', () => {
    it('handles ApiError correctly', () => {
        const err = new ApiError(404, 'Not Found');
        const req = {} as Request;
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
        } as unknown as Response;
        const next = vi.fn() as NextFunction;

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Not Found',
        });
    });

    it('handles generic Error correctly', () => {
        const err = new Error('Unexpected Boom');
        const req = {} as Request;
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
        } as unknown as Response;
        const next = vi.fn() as NextFunction;

        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            message: 'Internal Server Error',
        });
    });
});
