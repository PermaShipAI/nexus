export class ConfirmationNotFoundError extends Error {
  constructor() {
    super("Confirmation expired or not found");
    this.name = "ConfirmationNotFoundError";
  }
}
