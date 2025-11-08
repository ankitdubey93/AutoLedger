import {Request, Response, NextFunction} from "express";

import { JwtPayload } from "jsonwebtoken";
import ApiError from "../utils/apiError";
import pool from "../db/connect";

interface CustomRequest extends Request {
  user?: JwtPayload;
}


