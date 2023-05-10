import { getRandomId, Capacity } from "common";

export class Section {
  get id() {
    return this.section_id;
  }
  set id(_: string) {}

  section_id: string = getRandomId();
  budget_id: string = "";
  name: string = "";
  capacities: Capacity[] = [{ year: 0, month: 0, week: 0, day: 0 }];
  roll_over: boolean = false;
  roll_over_start_date?: string;

  constructor(init?: Partial<Section> & { budget_id: string }) {
    Object.assign(this, init);
  }
}
