import { Request, Response, NextFunction } from "express";
import ApiError from "../utils/apiError";

const errorHandler = (
  err: Error | ApiError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error("Error caught:", err);

  if(err instanceof ApiError) {
    res.status(err.statusCode).json({
        success: false,
        message: err.message,
    });
    return;
  }

  res.status(500).json({
    success: false,
    message: "Internal Server Error",
  });

  
};


export default errorHandler;