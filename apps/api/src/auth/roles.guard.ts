import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { StaffRole } from "@quickdrop/shared";
import { ROLES_KEY } from "./roles.decorator.js";
import type { RequestWithSession } from "./session.guard.js";

// §10.2/§11 — فصل الصلاحيات (threat #2: تلاعب مالي داخلي). يعمل **بعد** SessionGuard
// (يضبط request.staffSession). المعالج الموسوم بـ @Roles يُرفض 403 إن لم يكن دور الجلسة
// ضمن المسموح. حالتان تمرّان بلا فحص: (1) معالج بلا @Roles (متاح لأي دور — السلوك الحالي)،
// (2) لا staffSession = مسار Bearer STAFF_API_TOKEN للآلات الموثوقة (التوكن الرئيسي كامل
// الصلاحية أصلاً؛ الداشبورد بعد الإصلاح يمرّ بالكوكي فيُضبط staffSession ويُفحَص دوره).
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = request.staffSession;
    if (session === undefined) return true; // مسار الآلة (STAFF_API_TOKEN) — كامل الصلاحية
    if (!required.includes(session.role)) {
      console.warn(
        JSON.stringify({
          action: "roles_guard",
          outcome: "forbidden_role",
          tenant_id: session.tenantId,
          actor: session.staffId,
          role: session.role,
        }),
      );
      throw new ForbiddenException(); // §11 — رسالة عامة
    }
    return true;
  }
}
