pub fn asset(sound: &str) -> Result<Option<&'static [u8]>, ()> {
    match sound {
        "off" => Ok(None),
        "chime" => Ok(Some(include_bytes!("../../src/assets/sounds/chime.wav"))),
        "bell" => Ok(Some(include_bytes!("../../src/assets/sounds/bell.wav"))),
        "pulse" => Ok(Some(include_bytes!("../../src/assets/sounds/pulse.wav"))),
        _ => Err(()),
    }
}

#[cfg(windows)]
pub fn play(sound: &str) -> Result<(), ()> {
    use windows::{core::PCWSTR, Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT}};
    let data = asset(sound)?;
    // Async SND_MEMORY needs a process-lifetime buffer: include_bytes is static.
    let pointer = data.map_or(PCWSTR::null(), |bytes| PCWSTR(bytes.as_ptr().cast()));
    unsafe { PlaySoundW(pointer, None, SND_ASYNC | SND_MEMORY | SND_NODEFAULT) }.ok().map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bundled_short_pcm_sounds_can_be_requested() {
        assert!(asset("off").unwrap().is_none());
        for id in ["chime", "bell", "pulse"] {
            let bytes = asset(id).unwrap().unwrap();
            assert_eq!(&bytes[0..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WAVE");
            assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 1);
            assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 44100);
            assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize, bytes.len() - 44);
            assert!(bytes.len() > 44 && bytes.len() < 88244);
        }
        for id in ["", "../chime.wav", "https://example.com/tone.wav", "CHIME"] { assert!(asset(id).is_err()); }
    }
}
