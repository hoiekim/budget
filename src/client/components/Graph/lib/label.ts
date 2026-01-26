import { ViewDate, currencyCodeToSymbol, numberToCommaString } from "common";
import { Point } from "client";

export type LabelDirection = "left" | "right" | "top" | "bottom";

export class GraphLabel {
  direction: LabelDirection = "left";

  /**
   * Get label to display at the axis of the graph
   * @param i The index number of the grid to get label for
   * @param division The total number of divisions that the grid divides the graph
   * @param range The actual minimum and maximum value on the axis to display
   * @returns
   */
  get = (_i: number, _division: number, _range: Point): string | undefined => "";
}
type DateLocaleOptions = Intl.DateTimeFormatOptions & { week?: "long" | "short" };

export class DateLabel extends GraphLabel {
  viewDate: ViewDate;
  localeOptions?: DateLocaleOptions;

  /**
   * @param viewDate ViewDate of the last element of the graph range
   */
  constructor(viewDate: ViewDate, localeOptions?: DateLocaleOptions) {
    super();
    this.viewDate = viewDate;
    this.localeOptions = localeOptions;
  }

  /**
   * Get label to display at the axis of the graph
   * @param i The index number of the grid to get label for
   * @param division The total number of divisions that the grid divides the graph
   * @param range The actual minimum and maximum value on the axis to display
   * @returns
   */
  get = (i: number, division: number, range: Point) => {
    const { viewDate } = this;
    const [min, max] = range;
    const gridPosition = min + ((max - min) * i) / division;
    const prevGridPosition = min + ((max - min) * (i - 1)) / division;

    const movedViewDate = viewDate.clone().previous(gridPosition);
    const currentYear = movedViewDate.getComponents().year;

    const previousMovedViewDate = viewDate.clone().previous(prevGridPosition);
    const previousYear = previousMovedViewDate.getComponents().year;

    const options: DateLocaleOptions = {};
    if (!i || previousYear !== currentYear) options.year = "2-digit";

    switch (viewDate.getInterval()) {
      case "year":
        options.year = "numeric";
        break;
      case "month":
        options.month = "short";
        break;
    }

    if (this.localeOptions) Object.assign(options, this.localeOptions);

    return movedViewDate.toString(options);
  };
}

export class MoneyLabel extends GraphLabel {
  symbol: string;

  /**
   * @param currencyCode For example: "USD"
   */
  constructor(currencyCode: string) {
    super();
    this.symbol = currencyCodeToSymbol(currencyCode);
  }

  /**
   * Get label to display at the axis of the graph
   * @param i The index number of the grid to get label for
   * @param division The total number of divisions that the grid divides the graph
   * @param range The actual minimum and maximum value on the axis to display
   * @returns
   */
  get = (i: number, division: number, range: Point) => {
    const { symbol } = this;
    const [min, max] = range;
    const n = min + ((max - min) * (i + 1)) / division;
    return symbol + numberToCommaString(n, 0);
  };
}

export class NoLabel extends GraphLabel {
  get = () => undefined;
}
