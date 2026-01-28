import { DeepPartial } from "common";

export type Status = "not_ready" | "ok";

class StatusObject {
  isInit = false;
  isLoading = false;
  isError = false;
}

class StatusTracker {
  serverData = new StatusObject();
  budgetCalculation = new StatusObject();
  balanceCalculation = new StatusObject();

  get isInit() {
    return (
      this.serverData.isInit && this.budgetCalculation.isInit && this.balanceCalculation.isInit
    );
  }

  get isLoading() {
    return (
      this.serverData.isLoading ||
      this.budgetCalculation.isLoading ||
      this.balanceCalculation.isLoading
    );
  }

  get isError() {
    return (
      this.serverData.isError || this.budgetCalculation.isError || this.balanceCalculation.isError
    );
  }

  get status(): Status {
    if (this.isInit) return "ok";
    else return "not_ready";
  }

  update = (command: StatusUpdateCommand) => {
    if (command.serverData) this.serverData = Object.assign(this.serverData, command.serverData);
    if (command.budgetCalculation) {
      this.budgetCalculation = Object.assign(this.budgetCalculation, command.budgetCalculation);
    }
    if (command.balanceCalculation) {
      this.balanceCalculation = Object.assign(this.balanceCalculation, command.balanceCalculation);
    }
  };
}

export type StatusUpdateCommand = DeepPartial<StatusTracker>;

export const statusTracker = new StatusTracker();
