export async function finishRequest(request, response) {
    // workerd can invalidate the next forwarded request when a rejected body is left unread.
    if (request.body && !request.bodyUsed) await request.body.pipeTo(new WritableStream({ write() {} }));
    return response;
}
