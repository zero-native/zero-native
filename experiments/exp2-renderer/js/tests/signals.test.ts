import { describe, it, expect } from "bun:test";
import { signal, computed, effect, batch, untrack } from "../zn/signals";

describe("signals core", () => {
  it("creates and updates signals", () => {
    const [count, setCount] = signal(10);
    expect(count()).toBe(10);
    setCount(20);
    expect(count()).toBe(20);
    setCount((prev) => prev + 5);
    expect(count()).toBe(25);
  });

  it("triggers effects on dependency update", () => {
    const [text, setText] = signal("hello");
    let observed = "";
    let runs = 0;

    const dispose = effect(() => {
      observed = text();
      runs++;
    });

    expect(observed).toBe("hello");
    expect(runs).toBe(1);

    setText("world");
    expect(observed).toBe("world");
    expect(runs).toBe(2);

    dispose();
    setText("ignored");
    expect(observed).toBe("world");
    expect(runs).toBe(2);
  });

  it("evaluates computed values lazily and memoizes", () => {
    const [a, setA] = signal(2);
    const [b, setB] = signal(3);
    let computeRuns = 0;

    const sum = computed(() => {
      computeRuns++;
      return a() + b();
    });

    expect(computeRuns).toBe(0);
    expect(sum()).toBe(5);
    expect(computeRuns).toBe(1);
    expect(sum()).toBe(5);
    expect(computeRuns).toBe(1); // Memoized

    setA(10);
    expect(computeRuns).toBe(1); // Lazy: not recomputed until read
    expect(sum()).toBe(13);
    expect(computeRuns).toBe(2);
  });

  it("batches multiple mutations into a single effect run", () => {
    const [first, setFirst] = signal("Pavan");
    const [last, setLast] = signal("Kumar");
    let runs = 0;
    let fullName = "";

    effect(() => {
      fullName = `${first()} ${last()}`;
      runs++;
    });

    expect(runs).toBe(1);
    expect(fullName).toBe("Pavan Kumar");

    batch(() => {
      setFirst("Hero");
      setLast("Lava");
    });

    expect(runs).toBe(2);
    expect(fullName).toBe("Hero Lava");
  });

  it("untrack prevents subscription", () => {
    const [tracked, setTracked] = signal(1);
    const [untrackedVal, setUntrackedVal] = signal(100);
    let runs = 0;
    let sum = 0;

    effect(() => {
      runs++;
      sum = tracked() + untrack(() => untrackedVal());
    });

    expect(runs).toBe(1);
    expect(sum).toBe(101);

    setUntrackedVal(200);
    expect(runs).toBe(1); // Should NOT run
    expect(sum).toBe(101);

    setTracked(2);
    expect(runs).toBe(2);
    expect(sum).toBe(202);
  });
});
