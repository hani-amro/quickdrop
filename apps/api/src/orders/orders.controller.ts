import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import {
  OrdersService,
  type AssignOrderResponse,
  type CancelOrderResponse,
  type ConfirmOrderResponse,
  type CreateOrderResponse,
  type ListOrdersResponse,
  type OrderDetailResponse,
  type QuoteResponse,
} from "./orders.service.js";

// §10.1 D15 + §5/§6 — REST شاشة إنشاء الطلب اليدوي وأفعال الموظف بالداشبورد:
//   POST /api/orders/quote        → تسعير فوري بنفس محرك البوت (§4.4: السعر قبل الحفظ)
//   POST /api/orders              → إنشاء الطلب بفاعل staff
//   GET  /api/orders              → قائمة مختصرة (ترقيم من الخادم §10.1)
//   GET  /api/orders/:id          → تفاصيل اللوحة الجانبية (أحداث + عروض الجولة §10.1)
//   POST /api/orders/:id/confirm  → تأكيد + لقطة الوعد promised_at (§5/§7)
//   POST /api/orders/:id/cancel   → إلغاء المكتب بسبب مسمّى (§5)
//   POST /api/orders/:id/assign   → إسناد يدوي بانضباط أقفال dispatch (§6.2/§10.1)
// التحقق (Zod §11) والتخويل المؤقت (Bearer STAFF_API_TOKEN — §10.2 لاحقاً) بالخدمة.
@Controller("api/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post("quote")
  @HttpCode(200) // استعلام سعر، ليس إنشاء مورد — 200 لا 201
  async quote(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<QuoteResponse> {
    return this.orders.quote(authorization, body);
  }

  @Post()
  async create(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<CreateOrderResponse> {
    return this.orders.create(authorization, body);
  }

  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
    @Query() query: unknown,
  ): Promise<ListOrdersResponse> {
    return this.orders.list(authorization, query);
  }

  @Get(":id")
  async detail(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Query() query: unknown,
  ): Promise<OrderDetailResponse> {
    return this.orders.detail(authorization, id, query);
  }

  @Post(":id/confirm")
  @HttpCode(200) // فعل على مورد قائم، ليس إنشاء
  async confirm(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<ConfirmOrderResponse> {
    return this.orders.confirm(authorization, id, body);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<CancelOrderResponse> {
    return this.orders.cancel(authorization, id, body);
  }

  @Post(":id/assign")
  @HttpCode(200)
  async assign(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<AssignOrderResponse> {
    return this.orders.assign(authorization, id, body);
  }
}
