import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";
import { reportService } from "../services/reportService";



export const getTrialBalance = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.userId) return next(new ApiError(401, "Unauthorized"));

    const userId = req.user.userId;

    try {
        const report = await reportService.getTrialBalance(userId);

        res.status(200).json({
            success: true,
            ...report
        });

    } catch (error) {
        next(error);
    }
};