import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestTimeout } from '../../App/BuyNest/src/services/api/request-lifecycle.js';
import { ApiError } from '../../App/BuyNest/src/services/api/api-error.js';
import { keepPendingOrder } from '../../App/BuyNest/src/features/orders/pending-order-access.js';

afterEach(()=>vi.useRealTimers());
const rejectWhenAborted=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
});

describe('mobile request cancellation and timeouts',()=>{
  it('does not start a request when its screen is already cancelled',async()=>{
    const controller=new AbortController();controller.abort();const operation=vi.fn(async()=>42);
    await expect(withRequestTimeout(operation,controller.signal,1000)).rejects.toMatchObject({code:'NETWORK_ERROR'});
    expect(operation).not.toHaveBeenCalled();
  });
  it('normalizes cancellation during fetch instead of leaking a raw AbortError',async()=>{
    const controller=new AbortController();const request=withRequestTimeout(rejectWhenAborted,controller.signal,1000);
    const outcome=expect(request).rejects.toBeInstanceOf(ApiError);controller.abort();await outcome;
  });
  it('reports a timeout even if body-reading code catches the abort rejection',async()=>{
    vi.useFakeTimers();const request=withRequestTimeout(async signal=>{await rejectWhenAborted(signal).catch(()=>undefined);return undefined;},undefined,50);
    const outcome=expect(request).rejects.toMatchObject({code:'TIMEOUT'});await vi.advanceTimersByTimeAsync(50);await outcome;
  });
  it('reports cancellation during response-body reading even if its rejection is caught',async()=>{
    const controller=new AbortController();const request=withRequestTimeout(async signal=>{await rejectWhenAborted(signal).catch(()=>undefined);return undefined;},controller.signal,1000);
    const outcome=expect(request).rejects.toMatchObject({code:'NETWORK_ERROR'});controller.abort();await outcome;
  });
  it('removes listeners and timeout after success so later screen cleanup does not abort completed work',async()=>{
    vi.useFakeTimers();const controller=new AbortController();let observed:AbortSignal|undefined;
    expect(await withRequestTimeout(async signal=>{observed=signal;return 42;},controller.signal,50)).toBe(42);
    controller.abort();await vi.advanceTimersByTimeAsync(100);expect(observed?.aborted).toBe(false);
  });
  it('preserves typed API errors and normalizes network exceptions',async()=>{
    const typed=new ApiError('SERVICE_UNAVAILABLE');await expect(withRequestTimeout(async()=>{throw typed;},undefined,100)).rejects.toBe(typed);
    await expect(withRequestTimeout(async()=>{throw new TypeError('fetch failed');},undefined,100)).rejects.toMatchObject({code:'NETWORK_ERROR'});
  });
  it('keeps unresolved order submissions for both cancellation and timeout',()=>{
    expect(keepPendingOrder(new ApiError('TIMEOUT'),true,'buyer')).toBe(true);
    expect(keepPendingOrder(new ApiError('NETWORK_ERROR'),true,'buyer')).toBe(true);
  });
});
