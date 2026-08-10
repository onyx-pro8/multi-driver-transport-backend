import { pool } from "../database";
import { PublicUser, UserRow, toPublicUser } from "../models/user.model";
import { normalizeRole, type UserRole } from "../models/userRole.model";
import {
  ForgotPasswordRequest,
  LoginRequest,
  RegisterRequest,
  ResetPasswordRequest,
} from "../schemas/auth.schema";
import { hashPassword, verifyPassword } from "./password.service";
import {
  TokenPair,
  consumePasswordResetToken,
  issuePasswordResetToken,
  issueTokenPair,
  revokeAllUserRefreshTokens,
  revokeRefreshToken,
  validateRefreshToken,
} from "./token.service";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const USER_SELECT = `
  SELECT id, full_name, company_name, email, hashed_password, role, phone, address,
         lat, lng, trustworthiness, is_active, created_at, updated_at
  FROM users
`;

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function rowToUser(row: Record<string, unknown>): UserRow {
  const role: UserRole = normalizeRole(row.role);
  return {
    id: Number(row.id),
    full_name: String(row.full_name),
    company_name: String(row.company_name ?? ""),
    email: String(row.email),
    hashed_password: String(row.hashed_password),
    role,
    phone: String(row.phone ?? ""),
    address: String(row.address ?? ""),
    lat: toNullableNumber(row.lat),
    lng: toNullableNumber(row.lng),
    trustworthiness: Number(row.trustworthiness ?? 0),
    is_active: Boolean(row.is_active),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await pool.query(
    `${USER_SELECT} WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  if (result.rowCount === 0) return null;
  return rowToUser(result.rows[0]);
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const result = await pool.query(`${USER_SELECT} WHERE id = $1`, [id]);
  if (result.rowCount === 0) return null;
  return rowToUser(result.rows[0]);
}

export interface AuthResponse {
  user: PublicUser;
  tokens: TokenPair;
}

/**
 * Ensure a bootstrap admin exists from ADMIN_EMAIL + ADMIN_PASSWORD.
 * Creates the user when missing; syncs password/role when the email already exists.
 * No-op if either env var is unset.
 */
export async function ensureAdminUser(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.warn(
      "[auth] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin bootstrap"
    );
    return;
  }

  const hashed = await hashPassword(password);
  const fullName = (process.env.ADMIN_FULL_NAME || "Admin").trim() || "Admin";
  const existing = await findUserByEmail(email);

  if (!existing) {
    await pool.query(
      `INSERT INTO users (full_name, company_name, email, hashed_password, role, phone, address)
       VALUES ($1, '', $2, $3, 'admin', '', '')`,
      [fullName, email, hashed]
    );
    console.log(`[auth] bootstrap admin created: ${email}`);
    return;
  }

  await pool.query(
    `UPDATE users
     SET hashed_password = $1,
         role = 'admin',
         is_active = TRUE,
         updated_at = NOW()
     WHERE id = $2`,
    [hashed, existing.id]
  );
  console.log(`[auth] bootstrap admin synced: ${email}`);
}

export async function registerUser(input: RegisterRequest): Promise<AuthResponse> {
  const existing = await findUserByEmail(input.email);
  if (existing) throw new AuthError("Email already in use", 409);

  const hashed = await hashPassword(input.password);
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const role: UserRole =
    adminEmail && input.email.trim().toLowerCase() === adminEmail ? "admin" : input.role;

  const companyName = role === "driver" ? input.company_name.trim() : "";
  const address = input.address?.trim() ?? "";
  const lat = typeof input.lat === "number" ? input.lat : null;
  const lng = typeof input.lng === "number" ? input.lng : null;

  const result = await pool.query(
    `INSERT INTO users (full_name, company_name, email, hashed_password, role, phone, address, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, full_name, company_name, email, hashed_password, role, phone, address,
               lat, lng, trustworthiness, is_active, created_at, updated_at`,
    [input.full_name, companyName, input.email, hashed, role, input.phone, address, lat, lng]
  );

  const user = rowToUser(result.rows[0]);
  const tokens = await issueTokenPair(user.id, user.email);
  return { user: toPublicUser(user), tokens };
}

export async function loginUser(input: LoginRequest): Promise<AuthResponse> {
  const user = await findUserByEmail(input.email);
  if (!user) throw new AuthError("Invalid email or password", 401);
  if (!user.is_active) throw new AuthError("Account is disabled", 403);

  const ok = await verifyPassword(input.password, user.hashed_password);
  if (!ok) throw new AuthError("Invalid email or password", 401);

  const tokens = await issueTokenPair(user.id, user.email);
  return { user: toPublicUser(user), tokens };
}

export async function refreshSession(refreshToken: string): Promise<TokenPair> {
  let userId: number;
  try {
    userId = await validateRefreshToken(refreshToken);
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : "Invalid refresh token", 401);
  }

  const user = await getUserById(userId);
  if (!user || !user.is_active) throw new AuthError("Account not available", 401);

  await revokeRefreshToken(refreshToken);
  return issueTokenPair(user.id, user.email);
}

export async function logoutUser(refreshToken: string | undefined, userId: number | undefined): Promise<void> {
  if (refreshToken) await revokeRefreshToken(refreshToken);
  else if (userId) await revokeAllUserRefreshTokens(userId);
}

export interface ForgotPasswordResult {
  message: string;
  /**
   * Only returned in non-production environments to ease local testing. When
   * an email service is wired up this field disappears from responses.
   */
  reset_token?: string;
}

export async function forgotPassword(input: ForgotPasswordRequest): Promise<ForgotPasswordResult> {
  const user = await findUserByEmail(input.email);
  if (!user || !user.is_active) {
    return { message: "If the email exists, a reset link has been sent." };
  }

  const { token } = await issuePasswordResetToken(user.id);
  const result: ForgotPasswordResult = {
    message: "If the email exists, a reset link has been sent.",
  };
  if (process.env.NODE_ENV !== "production") {
    result.reset_token = token;
  }
  return result;
}

export async function resetPassword(input: ResetPasswordRequest): Promise<void> {
  let userId: number;
  try {
    userId = await consumePasswordResetToken(input.token);
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : "Invalid reset token", 400);
  }

  const hashed = await hashPassword(input.password);
  await pool.query(
    `UPDATE users SET hashed_password = $1, updated_at = NOW() WHERE id = $2`,
    [hashed, userId]
  );

  await revokeAllUserRefreshTokens(userId);
}
