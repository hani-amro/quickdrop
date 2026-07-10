import { uuidv7 } from "uuidv7";

// D11: PG16 بلا uuidv7() أصلي — التوليد بالتطبيق حصراً، وكل PK يمر من هنا.
export function newId(): string {
  return uuidv7();
}
