export interface CartLine {
  itemId: string;
  nameAr: string;
  price: string; // D5: مال سلسلة
  qty: number;
}

export type Cart = Record<string, CartLine>;

export function cartLines(cart: Cart): CartLine[] {
  return Object.values(cart);
}

export function cartCount(cart: Cart): number {
  return cartLines(cart).reduce((n, l) => n + l.qty, 0);
}
