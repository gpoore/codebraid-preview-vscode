// Copyright (c) 2022, Geoffrey M. Poore
// All rights reserved.
//
// Licensed under the BSD 3-Clause License:
// http://opensource.org/licenses/BSD-3-Clause
//


export function countNewlines(text: string) {
	let newlines: number = 0;
	for (const c of text) {
		if (c === '\n') {
			newlines += 1;
		}
	}
	return newlines;
}
