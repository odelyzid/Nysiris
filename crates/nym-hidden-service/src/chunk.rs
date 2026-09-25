//! Byte-level chunking for bodies larger than one Sphinx packet.
//!
//! One regular packet carries ~2 KB of plaintext, so multi-kilobyte bodies must
//! travel as several messages. These helpers split and rejoin the *bytes*;
//! framing (which chunk is which) is the caller's protocol — e.g. one envelope
//! per chunk with `?part=i/n` on the path, or sequential SURB replies. Keep the
//! framing explicit and authenticated at the application layer.

/// Split `data` into chunks of at most `max` bytes. Empty input yields no chunks.
pub fn split(data: &[u8], max: usize) -> Result<Vec<Vec<u8>>, String> {
    if max == 0 {
        return Err("chunk size must be positive".into());
    }
    Ok(data.chunks(max).map(|c| c.to_vec()).collect())
}

/// Rejoin chunks in order.
pub fn join(chunks: &[Vec<u8>]) -> Vec<u8> {
    chunks.concat()
}

/// Number of chunks `len` bytes need at `max` bytes per chunk.
pub fn count(len: usize, max: usize) -> Result<usize, String> {
    if max == 0 {
        return Err("chunk size must be positive".into());
    }
    Ok(len.div_ceil(max))
}
