//! Git's linear assignment (`linear-assignment.c`), ported as is so range-diff pairs commits as git
//! does, ties included. Jonker & Volgenant (1987), a shortest augmenting path algorithm.

/// Assigns columns to rows at least total cost, where `cost[column + columns * row]` is the cost
/// of assigning that column to that row. Returns each column's row and each row's column.
// Index loops and an advancing `up` inside `for k in up..` mirror the C, whose loop start is read once too.
#[allow(clippy::many_single_char_names, clippy::too_many_lines, clippy::needless_range_loop, clippy::mut_range_bound)]
pub fn compute_assignment(columns: usize, rows: usize, cost: &[i32]) -> (Vec<i32>, Vec<i32>) {
    let cost_at = |column: usize, row: usize| cost[column + columns * row];
    if columns < 2 {
        return (vec![0; columns], vec![0; rows]);
    }
    let mut column2row = vec![-1i32; columns];
    let mut row2column = vec![-1i32; rows];
    let mut v = vec![0i32; columns];
    // Column reduction.
    for j in (0..columns).rev() {
        let mut i1 = 0;
        for i in 1..rows {
            if cost_at(j, i1) > cost_at(j, i) {
                i1 = i;
            }
        }
        v[j] = cost_at(j, i1);
        if row2column[i1] == -1 {
            row2column[i1] = j as i32;
            column2row[j] = i1 as i32;
        } else {
            if row2column[i1] >= 0 {
                row2column[i1] = -2 - row2column[i1];
            }
            column2row[j] = -1;
        }
    }
    // Reduction transfer.
    let mut free_row = Vec::with_capacity(rows);
    for i in 0..rows {
        let j1 = row2column[i];
        if j1 == -1 {
            free_row.push(i);
        } else if j1 < -1 {
            row2column[i] = -2 - j1;
        } else {
            let j1 = j1 as usize;
            let other = usize::from(j1 == 0);
            let mut min = cost_at(other, i) - v[other];
            for j in 1..columns {
                if j != j1 && min > cost_at(j, i) - v[j] {
                    min = cost_at(j, i) - v[j];
                }
            }
            v[j1] -= min;
        }
    }
    if free_row.len() == rows.saturating_sub(columns) {
        return (column2row, row2column);
    }
    // Augmenting row reduction, twice.
    for _ in 0..2 {
        let mut k = 0;
        let saved = std::mem::take(&mut free_row);
        let mut pending = saved.clone();
        while k < pending.len() {
            let i = pending[k];
            k += 1;
            let mut j1 = 0usize;
            let mut u1 = cost_at(j1, i) - v[j1];
            let mut j2: i64 = -1;
            let mut u2 = i32::MAX;
            for j in 1..columns {
                let c = cost_at(j, i) - v[j];
                if u2 > c {
                    if u1 < c {
                        u2 = c;
                        j2 = j as i64;
                    } else {
                        u2 = u1;
                        u1 = c;
                        j2 = j1 as i64;
                        j1 = j;
                    }
                }
            }
            if j2 < 0 {
                j2 = j1 as i64;
                u2 = u1;
            }
            let mut i0 = column2row[j1];
            if u1 < u2 {
                v[j1] -= u2 - u1;
            } else if i0 >= 0 {
                j1 = j2 as usize;
                i0 = column2row[j1];
            }
            if i0 >= 0 {
                if u1 < u2 {
                    k -= 1;
                    pending[k] = i0 as usize;
                } else {
                    free_row.push(i0 as usize);
                }
            }
            row2column[i] = j1 as i32;
            column2row[j1] = i as i32;
        }
    }
    // Augmentation.
    let mut d = vec![0i32; columns];
    let mut pred = vec![0usize; columns];
    let mut col: Vec<usize> = vec![0; columns];
    for &i1 in &free_row {
        let (mut low, mut up) = (0usize, 0usize);
        for j in 0..columns {
            d[j] = cost_at(j, i1) - v[j];
            pred[j] = i1;
            col[j] = j;
        }
        let mut j: i64 = -1;
        let mut min;
        let last;
        'search: loop {
            let this_last = low;
            min = d[col[up]];
            up += 1;
            for k in up..columns {
                let jj = col[k];
                j = jj as i64;
                let c = d[jj];
                if c <= min {
                    if c < min {
                        up = low;
                        min = c;
                    }
                    col[k] = col[up];
                    col[up] = jj;
                    up += 1;
                }
            }
            // Git augments from `j`, the column its loop above saw last, not the free one found here.
            if col[low..up].iter().any(|&candidate| column2row[candidate] == -1) {
                last = this_last;
                break 'search;
            }
            // Scan a row.
            loop {
                let j1 = col[low];
                low += 1;
                let i = column2row[j1] as usize;
                let u1 = cost_at(j1, i) - v[j1] - min;
                for k in up..columns {
                    let jj = col[k];
                    j = jj as i64;
                    let c = cost_at(jj, i) - v[jj] - u1;
                    if c < d[jj] {
                        d[jj] = c;
                        pred[jj] = i;
                        if c == min {
                            if column2row[jj] == -1 {
                                last = this_last;
                                break 'search;
                            }
                            col[k] = col[up];
                            col[up] = jj;
                            up += 1;
                        }
                    }
                }
                if low == up {
                    break;
                }
            }
            if low != up {
                last = this_last;
                break;
            }
        }
        // Update the column prices.
        for &j1 in &col[..last] {
            v[j1] += d[j1] - min;
        }
        // Augment along the path.
        let mut j = j as usize;
        loop {
            let i = pred[j];
            column2row[j] = i as i32;
            let previous = row2column[i];
            row2column[i] = j as i32;
            if i == i1 {
                break;
            }
            j = previous as usize;
        }
    }
    (column2row, row2column)
}
