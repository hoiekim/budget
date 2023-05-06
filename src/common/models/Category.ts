import { getRandomId, Capacity } from "common";

export class Category {
  get id() {
    return this.category_id;
  }
  category_id: string = getRandomId();
  section_id: string = "";
  name: string = "";
  capacities: Capacity[] = [{ year: 0, month: 0, week: 0, day: 0 }];
  roll_over: boolean = false;
  roll_over_start_date?: string;

  constructor(init?: Partial<Category> & { section_id: string }) {
    Object.assign(this, init);
  }
}
