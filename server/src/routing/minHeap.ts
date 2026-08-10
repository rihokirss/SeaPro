/** Deterministlik binaarkuhi; comparator peab andma täieliku järjestuse. */
export class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.#compare = compare;
  }

  get size(): number { return this.#items.length; }

  push(value: T): void {
    const items = this.#items;
    let index = items.length;
    items.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.#compare(items[parent]!, value) <= 0) break;
      items[index] = items[parent]!;
      index = parent;
    }
    items[index] = value;
  }

  pop(): T | undefined {
    const items = this.#items;
    const first = items[0];
    const last = items.pop();
    if (first == null || last == null || items.length === 0) return first;
    let index = 0;
    items[0] = last;
    while (true) {
      const left = index * 2 + 1;
      if (left >= items.length) break;
      const right = left + 1;
      let child = left;
      if (right < items.length && this.#compare(items[right]!, items[left]!) < 0) child = right;
      if (this.#compare(items[child]!, items[index]!) >= 0) break;
      [items[index], items[child]] = [items[child]!, items[index]!];
      index = child;
    }
    return first;
  }
}
