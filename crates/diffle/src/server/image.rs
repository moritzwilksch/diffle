//! Telling raster images by their bytes, so only an image is ever served as one.

/// Leading bytes of the raster formats browsers display; `None` matches any byte.
const SIGNATURES: &[(&str, &[Option<u8>])] = &[
    ("image/png", &[Some(0x89), Some(b'P'), Some(b'N'), Some(b'G'), Some(0x0d), Some(0x0a), Some(0x1a), Some(0x0a)]),
    ("image/jpeg", &[Some(0xff), Some(0xd8), Some(0xff)]),
    ("image/gif", &[Some(b'G'), Some(b'I'), Some(b'F'), Some(b'8')]),
    (
        "image/webp",
        &[
            Some(b'R'),
            Some(b'I'),
            Some(b'F'),
            Some(b'F'),
            None,
            None,
            None,
            None,
            Some(b'W'),
            Some(b'E'),
            Some(b'B'),
            Some(b'P'),
        ],
    ),
    (
        "image/avif",
        &[
            None,
            None,
            None,
            None,
            Some(b'f'),
            Some(b't'),
            Some(b'y'),
            Some(b'p'),
            Some(b'a'),
            Some(b'v'),
            Some(b'i'),
            Some(b'f'),
        ],
    ),
    (
        "image/avif",
        &[
            None,
            None,
            None,
            None,
            Some(b'f'),
            Some(b't'),
            Some(b'y'),
            Some(b'p'),
            Some(b'a'),
            Some(b'v'),
            Some(b'i'),
            Some(b's'),
        ],
    ),
    ("image/bmp", &[Some(b'B'), Some(b'M')]),
    ("image/x-icon", &[Some(0x00), Some(0x00), Some(0x01), Some(0x00)]),
];

/// The media type of a raster image, read from its leading bytes; none for anything else. The
/// extension is not consulted.
pub fn image_type(buf: &[u8]) -> Option<&'static str> {
    SIGNATURES.iter().find_map(|(kind, magic)| {
        let matches = buf.len() >= magic.len() && magic.iter().zip(buf).all(|(m, b)| m.is_none_or(|m| m == *b));
        matches.then_some(*kind)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_type_from_magic_bytes_alone() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(image_type(b"<svg xmlns="), None);
        assert_eq!(image_type(b"\x89PN"), None);
        assert_eq!(image_type(&[0, 1, 2, 3, 0]), None);
        assert_eq!(image_type(b""), None);
    }
}
