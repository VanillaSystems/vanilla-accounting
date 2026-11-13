/**
 * Loads begun one after the other whose answers may arrive in any order (#424): `begin()` for each
 * load, and its answer is shown only when no later load's answer is shown already. An earlier
 * answer arriving last never replaces a later one; one that arrives first is shown until the later
 * comes, so loads begun faster than they answer still show the books as they move.
 */
export function latestLoad(): () => () => boolean {
  let begun = 0;
  let shown = 0;
  return () => {
    const mine = ++begun;
    return () => {
      if (mine < shown) return false;
      shown = mine;
      return true;
    };
  };
}
