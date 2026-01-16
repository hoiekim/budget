export class Average {
  private sum: number = 0;
  private count: number = 0;

  get value() {
    if (this.count === 0) return 0;
    return this.sum / this.count;
  }

  put = (value: number) => {
    this.sum += value;
    this.count += 1;
  };

  merge = (that: Average) => {
    this.sum += that.sum;
    this.count += that.count;
  };
}
