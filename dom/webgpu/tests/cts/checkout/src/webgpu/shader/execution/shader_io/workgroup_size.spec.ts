export const description = `Test that workgroup size is set correctly`;

import { makeTestGroup } from '../../../../common/framework/test_group.js';
import { iterRange } from '../../../../common/util/util.js';
import { AllFeaturesMaxLimitsGPUTest } from '../../../gpu_test.js';

export const g = makeTestGroup(AllFeaturesMaxLimitsGPUTest);

function checkResults(
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  numWGs: number,
  data: Uint32Array
): Error | undefined {
  const totalInvocations = sizeX * sizeY * sizeZ;
  for (let i = 0; i < numWGs; i++) {
    const wgx_data = data[4 * i + 0];
    const wgy_data = data[4 * i + 1];
    const wgz_data = data[4 * i + 2];
    const total_data = data[4 * i + 3];
    if (wgx_data !== sizeX) {
      let msg = `Incorrect workgroup size x dimension for wg ${i}:\n`;
      msg += `- expected: ${wgx_data}\n`;
      msg += `- got:      ${sizeX}`;
      return Error(msg);
    }
    if (wgy_data !== sizeY) {
      let msg = `Incorrect workgroup size y dimension for wg ${i}:\n`;
      msg += `- expected: ${wgy_data}\n`;
      msg += `- got:      ${sizeY}`;
      return Error(msg);
    }
    if (wgz_data !== sizeZ) {
      let msg = `Incorrect workgroup size y dimension for wg ${i}:\n`;
      msg += `- expected: ${wgz_data}\n`;
      msg += `- got:      ${sizeZ}`;
      return Error(msg);
    }
    if (total_data !== totalInvocations) {
      let msg = `Incorrect workgroup total invocations for wg ${i}:\n`;
      msg += `- expected: ${total_data}\n`;
      msg += `- got:      ${totalInvocations}`;
      return Error(msg);
    }
  }
  return undefined;
}

g.test('workgroup_size')
  .desc(`Test workgroup size is set correctly`)
  .params(u =>
    u
      .combine('wgx', [1, 3, 4, 8, 11, 16, 51, 64, 128, 256] as const)
      .combine('wgy', [1, 3, 4, 8, 16, 51, 64, 256] as const)
      .combine('wgz', [1, 3, 11, 16, 128, 256] as const)
      .beginSubcases()
  )
  .fn(async t => {
    const {
      maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ,
      maxComputeInvocationsPerWorkgroup,
    } = t.device.limits;
    t.skipIf(
      t.params.wgx > maxComputeWorkgroupSizeX,
      `workgroup size x: ${t.params.wgx} > limit: ${maxComputeWorkgroupSizeX}`
    );
    t.skipIf(
      t.params.wgy > maxComputeWorkgroupSizeY,
      `workgroup size x: ${t.params.wgy} > limit: ${maxComputeWorkgroupSizeY}`
    );
    t.skipIf(
      t.params.wgz > maxComputeWorkgroupSizeZ,
      `workgroup size x: ${t.params.wgz} > limit: ${maxComputeWorkgroupSizeZ}`
    );
    const totalInvocations = t.params.wgx * t.params.wgy * t.params.wgz;
    t.skipIf(
      totalInvocations > maxComputeInvocationsPerWorkgroup,
      `workgroup size: ${totalInvocations} > limit: ${maxComputeInvocationsPerWorkgroup}`
    );

    const code = `
struct Values {
  x : atomic<u32>,
  y : atomic<u32>,
  z : atomic<u32>,
  total : atomic<u32>,
}

@group(0) @binding(0)
var<storage, read_write> v : array<Values>;

@compute @workgroup_size(${t.params.wgx}, ${t.params.wgy}, ${t.params.wgz})
fn main(@builtin(local_invocation_id) lid : vec3u,
        @builtin(workgroup_id) wgid : vec3u) {
  atomicMax(&v[wgid.x].x, lid.x + 1);
  atomicMax(&v[wgid.x].y, lid.y + 1);
  atomicMax(&v[wgid.x].z, lid.z + 1);
  atomicAdd(&v[wgid.x].total, 1);
}`;

    const pipeline = t.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: t.device.createShaderModule({
          code,
        }),
        entryPoint: 'main',
      },
    });

    const numWorkgroups = totalInvocations < 256 ? 5 : 3;
    const buffer = t.makeBufferWithContents(
      new Uint32Array([...iterRange(numWorkgroups * 4, _i => 0)]),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    );

    const bg = t.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer,
          },
        },
      ],
    });

    const encoder = t.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(numWorkgroups, 1, 1);
    pass.end();
    t.queue.submit([encoder.finish()]);

    const bufferReadback = await t.readGPUBufferRangeTyped(buffer, {
      srcByteOffset: 0,
      type: Uint32Array,
      typedLength: 4 * numWorkgroups,
      method: 'copy',
    });
    const data: Uint32Array = bufferReadback.data;

    t.expectOK(checkResults(t.params.wgx, t.params.wgy, t.params.wgz, numWorkgroups, data));
  });

g.test('workgroup_size_override_exp')
  .desc(`Test workgroup size can be set from an override expression`)
  .params(u =>
    u
      .combine('override1', [1, 3, 4, 8, 11, 16, 51, 64, 128, 256] as const)
      .combine('override2', [1, 2, 3, 4] as const)
      .combine('override3', [1, 2, 4, 8] as const)
      .beginSubcases()
  )
  .fn(async t => {
    const {
      maxComputeWorkgroupSizeX,
      maxComputeWorkgroupSizeY,
      maxComputeWorkgroupSizeZ,
      maxComputeInvocationsPerWorkgroup,
    } = t.device.limits;

    // These expressions need to be identical workgroup size expressions for the compute shader
    const wgx = t.params.override1 + t.params.override2 + t.params.override3;
    const wgy = t.params.override1 + t.params.override2 * t.params.override2;
    const wgz = t.params.override1 + t.params.override3 * t.params.override3;

    t.skipIf(
      wgx > maxComputeWorkgroupSizeX,
      `workgroup size x: ${wgx} > limit: ${maxComputeWorkgroupSizeX}`
    );
    t.skipIf(
      wgy > maxComputeWorkgroupSizeY,
      `workgroup size x: ${wgy} > limit: ${maxComputeWorkgroupSizeY}`
    );
    t.skipIf(
      wgz > maxComputeWorkgroupSizeZ,
      `workgroup size x: ${wgz} > limit: ${maxComputeWorkgroupSizeZ}`
    );
    const totalInvocations = wgx * wgy * wgz;
    t.skipIf(
      totalInvocations > maxComputeInvocationsPerWorkgroup,
      `workgroup size: ${totalInvocations} > limit: ${maxComputeInvocationsPerWorkgroup}`
    );

    const code = `
struct Values {
  x : atomic<u32>,
  y : atomic<u32>,
  z : atomic<u32>,
  total : atomic<u32>,
}

@group(0) @binding(0)
var<storage, read_write> v : array<Values>;
override override1: u32;
override override2: u32;
override override3: u32;

@compute @workgroup_size(override1 + override2 + override3,
  override1 + override2 * override2,
 override1 + override3 * override3)
fn main(@builtin(local_invocation_id) lid : vec3u,
        @builtin(workgroup_id) wgid : vec3u) {
  atomicMax(&v[wgid.x].x, lid.x + 1);
  atomicMax(&v[wgid.x].y, lid.y + 1);
  atomicMax(&v[wgid.x].z, lid.z + 1);
  atomicAdd(&v[wgid.x].total, 1);
}`;

    const pipeline = t.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: t.device.createShaderModule({
          code,
        }),
        entryPoint: 'main',
        constants: {
          override1: t.params.override1,
          override2: t.params.override2,
          override3: t.params.override3,
        },
      },
    });

    const numWorkgroups = totalInvocations < 256 ? 5 : 3;
    const buffer = t.makeBufferWithContents(
      new Uint32Array([...iterRange(numWorkgroups * 4, _i => 0)]),
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    );

    const bg = t.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: {
            buffer,
          },
        },
      ],
    });

    const encoder = t.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(numWorkgroups, 1, 1);
    pass.end();
    t.queue.submit([encoder.finish()]);

    const bufferReadback = await t.readGPUBufferRangeTyped(buffer, {
      srcByteOffset: 0,
      type: Uint32Array,
      typedLength: 4 * numWorkgroups,
      method: 'copy',
    });
    const data: Uint32Array = bufferReadback.data;

    t.expectOK(checkResults(wgx, wgy, wgz, numWorkgroups, data));
  });
