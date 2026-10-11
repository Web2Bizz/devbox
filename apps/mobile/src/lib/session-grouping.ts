// Pure helpers for grouping the session list by project directory.
// No React Native imports — unit-testable with node --test.

/** A contiguous-by-directory bucket of items, in first-seen order. */
export interface DirectoryGroup<T> {
  directory: string
  items: T[]
}

/**
 * Groups items by their `directory` field, preserving both the original
 * item order within a group and the order in which each directory was
 * first encountered. Does not sort — callers decide presentation order.
 */
export function groupByDirectory<T extends { directory: string }>(items: T[]): DirectoryGroup<T>[] {
  const order: string[] = []
  const buckets = new Map<string, T[]>()

  for (const item of items) {
    const dir = item.directory
    let bucket = buckets.get(dir)
    if (!bucket) {
      bucket = []
      buckets.set(dir, bucket)
      order.push(dir)
    }
    bucket.push(item)
  }

  return order.map((directory) => ({ directory, items: buckets.get(directory) as T[] }))
}

/** A project card bucket: one directory on ONE server. Same path on two
 *  servers is two cards (keyed by connection), never merged. */
export interface ProjectGroup<T> {
  key: string
  directory: string
  connectionId: string
  items: T[]
}

/**
 * Groups sessions by (connection, directory) for project cards spanning
 * several servers. Order rules match groupByDirectory (first-seen), callers
 * sort for presentation.
 */
export function groupProjects<T extends { directory: string; connectionId: string }>(items: T[]): ProjectGroup<T>[] {
  const order: string[] = []
  const buckets = new Map<string, T[]>()

  for (const item of items) {
    const key = `${item.connectionId}::${item.directory}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
      order.push(key)
    }
    bucket.push(item)
  }

  return order.map((key) => {
    const items = buckets.get(key) as T[]
    return { key, directory: items[0].directory, connectionId: items[0].connectionId, items }
  })
}
