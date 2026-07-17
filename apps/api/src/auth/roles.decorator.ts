import { SetMetadata } from "@nestjs/common";
import type { StaffRole } from "@quickdrop/shared";

// §10.2/§11 — فصل الصلاحيات: يوسم معالجاً بالأدوار المسموح لها. RolesGuard يفرضه بعد
// SessionGuard. غياب الوسم = متاح لأي دور طاقم (السلوك الحالي)؛ وجوده = حصر.
export const ROLES_KEY = "quickdrop:roles";

export const Roles = (...roles: StaffRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
