package com.example.backend.service;

import com.example.backend.dto.NoticeDto;
import com.example.backend.entity.Notice;
import com.example.backend.repository.NoticeRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class NoticeService {

    private final NoticeRepository noticeRepository;

    public List<NoticeDto> getAll() {
        return noticeRepository.findAllByOrderByIsPinnedDescCreatedAtDesc()
                .stream().map(NoticeDto::from).collect(Collectors.toList());
    }

    public NoticeDto getOne(Long id) {
        Notice notice = noticeRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("공지사항을 찾을 수 없습니다."));
        return NoticeDto.from(notice);
    }

    public NoticeDto create(NoticeDto dto) {
        Notice notice = Notice.builder()
                .title(dto.getTitle())
                .content(dto.getContent())
                .isPinned(dto.getIsPinned() != null ? dto.getIsPinned() : false)
                .build();
        return NoticeDto.from(noticeRepository.save(notice));
    }

    public NoticeDto update(Long id, NoticeDto dto) {
        Notice notice = noticeRepository.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("공지사항을 찾을 수 없습니다."));
        notice.setTitle(dto.getTitle());
        notice.setContent(dto.getContent());
        notice.setIsPinned(dto.getIsPinned() != null ? dto.getIsPinned() : false);
        return NoticeDto.from(noticeRepository.save(notice));
    }

    public void delete(Long id) {
        noticeRepository.deleteById(id);
    }
}