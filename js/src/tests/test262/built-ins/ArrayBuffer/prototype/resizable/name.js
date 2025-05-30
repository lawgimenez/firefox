// Copyright (C) 2021 the V8 project authors. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.
/*---
esid: sec-get-arraybuffer.prototype.resizable
description: >
  get ArrayBuffer.prototype.resizable

  17 ECMAScript Standard Built-in Objects

  Functions that are specified as get or set accessor functions of built-in
  properties have "get " or "set " prepended to the property name string.

includes: [propertyHelper.js]
features: [resizable-arraybuffer]
---*/

var desc = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable');

verifyProperty(desc.get, 'name', {
  value: 'get resizable',
  enumerable: false,
  writable: false,
  configurable: true
});

reportCompare(0, 0);
