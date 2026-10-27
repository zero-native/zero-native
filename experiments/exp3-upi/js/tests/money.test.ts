import { describe, it, expect } from "bun:test";
import {
  formatIndianDisplay,
  parseToPaise,
  calculateFinancials,
  applyKeypadInput,
  applyBackspace,
  SessionData,
} from "../zn/money";

describe("money & financial logic", () => {
  it("formats numbers with Indian grouping", () => {
    expect(formatIndianDisplay("0")).toBe("0");
    expect(formatIndianDisplay("5")).toBe("5");
    expect(formatIndianDisplay("50")).toBe("50");
    expect(formatIndianDisplay("500")).toBe("500");
    expect(formatIndianDisplay("1250")).toBe("1,250");
    expect(formatIndianDisplay("12500")).toBe("12,500");
    expect(formatIndianDisplay("123456")).toBe("1,23,456");
    expect(formatIndianDisplay("1234567")).toBe("12,34,567");
    expect(formatIndianDisplay("1250.5")).toBe("1,250.5");
    expect(formatIndianDisplay("123456.75")).toBe("1,23,456.75");
  });

  it("converts strings to integer paise accurately", () => {
    expect(parseToPaise("0")).toBe(0);
    expect(parseToPaise("1")).toBe(100);
    expect(parseToPaise("1.5")).toBe(150);
    expect(parseToPaise("1.50")).toBe(150);
    expect(parseToPaise("1250.75")).toBe(125075);
  });

  it("calculates cashback and platform fee correctly", () => {
    const session: SessionData = {
      max_cashback: 50,
      min_total_to_use_cashback: 200,
      platform_fee: 5,
    };

    // Amount <= max_cashback: no cashback
    expect(calculateFinancials(50, session)).toEqual({
      cashback: 0,
      fee: 0,
      toPay: 50,
    });

    // Amount > max_cashback but < min_total: no cashback
    expect(calculateFinancials(150, session)).toEqual({
      cashback: 0,
      fee: 0,
      toPay: 150,
    });

    // Amount >= min_total: eligible for cashback and platform fee
    expect(calculateFinancials(250, session)).toEqual({
      cashback: 50,
      fee: 5,
      toPay: 205, // 250 - 50 + 5
    });
  });

  it("enforces keypad rules (7 digits, 2 decimals, single dot)", () => {
    let input = "0";
    input = applyKeypadInput(input, "1");
    expect(input).toBe("1");
    input = applyKeypadInput(input, "2");
    expect(input).toBe("12");
    input = applyKeypadInput(input, "3");
    input = applyKeypadInput(input, "4");
    input = applyKeypadInput(input, "5");
    input = applyKeypadInput(input, "6");
    input = applyKeypadInput(input, "7");
    expect(input).toBe("1234567");

    // 8th integer digit rejected
    input = applyKeypadInput(input, "8");
    expect(input).toBe("1234567");

    // Add decimal
    input = applyKeypadInput(input, ".");
    expect(input).toBe("1234567.");

    // Duplicate decimal rejected
    input = applyKeypadInput(input, ".");
    expect(input).toBe("1234567.");

    // Add 2 decimal digits
    input = applyKeypadInput(input, "5");
    expect(input).toBe("1234567.5");
    input = applyKeypadInput(input, "9");
    expect(input).toBe("1234567.59");

    // 3rd decimal digit rejected
    input = applyKeypadInput(input, "9");
    expect(input).toBe("1234567.59");
  });

  it("handles backspace correctly", () => {
    expect(applyBackspace("123")).toBe("12");
    expect(applyBackspace("12")).toBe("1");
    expect(applyBackspace("1")).toBe("0");
    expect(applyBackspace("0")).toBe("0");
  });
});
