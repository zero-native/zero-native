// exp4-flow/js/zn/modifier.ts - Argon Specification: Chained Jetpack Compose Modifiers
export interface ModifierTuple {
  type: string;
  args: any[];
}

export class ModifierChain {
  readonly tuples: ModifierTuple[];

  constructor(tuples: ModifierTuple[] = []) {
    this.tuples = tuples;
  }

  padding(
    allOrConfig:
      | number
      | {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
          horizontal?: number;
          vertical?: number;
        }
  ): ModifierChain {
    if (typeof allOrConfig === "number") {
      return new ModifierChain([
        ...this.tuples,
        { type: "padAll", args: [allOrConfig] },
      ]);
    }
    const {
      top = 0,
      bottom = 0,
      left = 0,
      right = 0,
      horizontal = 0,
      vertical = 0,
    } = allOrConfig;
    const padT = top || vertical;
    const padB = bottom || vertical;
    const padL = left || horizontal;
    const padR = right || horizontal;
    return new ModifierChain([
      ...this.tuples,
      { type: "pad", args: [padT, padB, padL, padR] },
    ]);
  }

  /**
   * Margin in Jetpack Compose is semantically a padding applied BEFORE background
   */
  margin(
    allOrConfig:
      | number
      | {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
          horizontal?: number;
          vertical?: number;
        }
  ): ModifierChain {
    return this.padding(allOrConfig);
  }

  background(color: string, shapeRadius: number = 0): ModifierChain {
    return new ModifierChain([
      ...this.tuples,
      { type: "bg", args: [color, shapeRadius] },
    ]);
  }

  width(w: number | "100%"): ModifierChain {
    return new ModifierChain([...this.tuples, { type: "width", args: [w] }]);
  }

  height(h: number | "100%"): ModifierChain {
    return new ModifierChain([...this.tuples, { type: "height", args: [h] }]);
  }

  size(w: number, h?: number): ModifierChain {
    return new ModifierChain([
      ...this.tuples,
      { type: "size", args: [w, h ?? w] },
    ]);
  }

  fillMaxSize(): ModifierChain {
    return new ModifierChain([...this.tuples, { type: "fillMax", args: [] }]);
  }

  fillMaxWidth(): ModifierChain {
    return this.width("100%");
  }

  fillMaxHeight(): ModifierChain {
    return this.height("100%");
  }

  rounded(radius: number): ModifierChain {
    return new ModifierChain([...this.tuples, { type: "clip", args: [radius] }]);
  }

  border(width: number, color: string, radius: number = 0): ModifierChain {
    return new ModifierChain([
      ...this.tuples,
      { type: "border", args: [width, color, radius] },
    ]);
  }

  alpha(opacity: number): ModifierChain {
    return new ModifierChain([...this.tuples, { type: "alpha", args: [opacity] }]);
  }

  clickable(onPress: () => void, haptic?: string): ModifierChain {
    return new ModifierChain([
      ...this.tuples,
      { type: "click", args: [onPress, haptic] },
    ]);
  }

  toJSON(): any[] {
    return this.tuples.map((t) => [t.type, ...t.args]);
  }
}

export const mod = new ModifierChain();
