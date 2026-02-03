package bin

import (
	"archive/zip"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type GitHubRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	PublishedAt time.Time `json:"published_at"`
	Prerelease  bool      `json:"prerelease"`
	Assets      []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

type ReleaseInfo struct {
	Version      string `json:"version"`
	Name         string `json:"name"`
	PublishedAt  string `json:"publishedAt"`
	IsPrerelease bool   `json:"isPrerelease"`
}

type ReleasesResponse struct {
	Success  bool          `json:"success"`
	Releases []ReleaseInfo `json:"releases,omitempty"`
	Error    string        `json:"error,omitempty"`
}

type UpdateRequest struct {
	Core       string `json:"core"`
	Version    string `json:"version"`
	BackupCore bool   `json:"backupCore"`
}

func getAssetName(core, version string) string {
	arch := runtime.GOARCH
	if core == "xray" {
		archMap := map[string]string{
			"arm64":  "linux-arm64-v8a",
			"mips":   "linux-mips32",
			"mipsle": "linux-mips32le",
		}
		if mapped, ok := archMap[arch]; ok {
			return fmt.Sprintf("Xray-%s.zip", mapped)
		}
	} else if core == "mihomo" {
		archMap := map[string]string{
			"arm64":  "linux-arm64",
			"mips":   "linux-mips-softfloat",
			"mipsle": "linux-mipsle-softfloat",
		}
		if mapped, ok := archMap[arch]; ok {
			return fmt.Sprintf("mihomo-%s-v%s.gz", mapped, version)
		}
	}
	return ""
}

func UpdateHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		core := r.URL.Query().Get("core")
		if core == "" {
			jsonResponse(w, Response{Success: false, Error: "Core parameter required"}, 400)
			return
		}
		var repoURL string
		switch core {
		case "xray":
			repoURL = "https://api.github.com/repos/XTLS/Xray-core/releases"
		case "mihomo":
			repoURL = "https://api.github.com/repos/MetaCubeX/mihomo/releases"
		default:
			jsonResponse(w, Response{Success: false, Error: "Unknown core"}, 400)
			return
		}
		client := &http.Client{Timeout: 10 * time.Second}
		req, err := http.NewRequest("GET", repoURL, nil)
		if err != nil {
			DebugLog("Failed to create request: %v", err)
			jsonResponse(w, ReleasesResponse{Success: false, Error: "Request creation failed"}, 500)
			return
		}
		req.Header.Set("Accept", "application/vnd.github.v3+json")
		resp, err := client.Do(req)
		if err != nil {
			DebugLog("Failed to fetch releases: %v", err)
			jsonResponse(w, ReleasesResponse{Success: false, Error: "Failed to fetch releases"}, 500)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			DebugLog("GitHub API returned status %d", resp.StatusCode)
			jsonResponse(w, ReleasesResponse{Success: false, Error: fmt.Sprintf("GitHub API error: %d", resp.StatusCode)}, 500)
			return
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			DebugLog("Failed to read response: %v", err)
			jsonResponse(w, ReleasesResponse{Success: false, Error: "Failed to read response"}, 500)
			return
		}
		var ghReleases []GitHubRelease
		if err := json.Unmarshal(body, &ghReleases); err != nil {
			DebugLog("Failed to parse JSON: %v", err)
			jsonResponse(w, ReleasesResponse{Success: false, Error: "Failed to parse releases"}, 500)
			return
		}
		var releases []ReleaseInfo
		for i, rel := range ghReleases {
			if i >= 10 {
				break
			}
			version := rel.TagName
			if strings.HasPrefix(version, "v") {
				version = version[1:]
			}
			releases = append(releases, ReleaseInfo{
				Version:      version,
				Name:         rel.Name,
				PublishedAt:  rel.PublishedAt.Format("2006-01-02"),
				IsPrerelease: rel.Prerelease,
			})
		}
		jsonResponse(w, ReleasesResponse{Success: true, Releases: releases}, 200)
	case "POST":
		var req UpdateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonResponse(w, Response{Success: false, Error: "Invalid JSON"}, 400)
			return
		}
		if req.Core != "xray" && req.Core != "mihomo" {
			jsonResponse(w, Response{Success: false, Error: "Invalid core"}, 400)
			return
		}
		if req.Version == "" {
			jsonResponse(w, Response{Success: false, Error: "Version required"}, 400)
			return
		}
		if err := performUpdate(req); err != nil {
			jsonResponse(w, Response{Success: false, Error: err.Error()}, 500)
			return
		}
		jsonResponse(w, Response{Success: true}, 200)
	default:
		jsonResponse(w, Response{Success: false, Error: "Method not allowed"}, 405)
	}
}

func performUpdate(req UpdateRequest) error {
	f, err := os.OpenFile(ErrorLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("failed to open error log: %v", err)
	}
	defer f.Close()

	log := func(format string, args ...any) {
		msg := fmt.Sprintf("%s <span class=\"log-badge log-badge-info\" data-filter=\"INFO\">INFO</span> ",
			time.Now().Format("2006/01/02 15:04:05.000000")) +
			fmt.Sprintf(format, args...)
		f.WriteString(msg + "\n")
		DebugLog(format, args...)
	}

	log("Начинаю обновление %s до версии %s", req.Core, req.Version)

	tmpDir := "/opt/tmp"
	os.MkdirAll(tmpDir, 0755)

	version := req.Version
	if !strings.HasPrefix(version, "v") {version = "v" + version }

	assetName := getAssetName(req.Core, strings.TrimPrefix(version, "v"))
	if assetName == "" {
		err := fmt.Errorf("asset not found for core %s on architecture %s", req.Core, runtime.GOARCH)
		log("Ассет не найден: %v", err)
		return err
	}
	log("Файл для загрузки: %s", assetName)

	var downloadURL string
	if req.Core == "xray" {
		downloadURL = fmt.Sprintf("https://github.com/XTLS/Xray-core/releases/download/%s/%s", version, assetName)
	} else {
		downloadURL = fmt.Sprintf("https://github.com/MetaCubeX/mihomo/releases/download/%s/%s", version, assetName)
	}
	log("URL для загрузки: %s", downloadURL)

	archivePath := filepath.Join(tmpDir, assetName)
	log("Загрузка файла в: %s", archivePath)

	if err := downloadFile(downloadURL, archivePath); err != nil {
		log("Ошибка загрузки: %v", err)
		return err
	}
	log("Загрузка завершена успешно")

	var binPath string
	if req.Core == "xray" {
		binPath = filepath.Join(tmpDir, "xray")
		log("Распаковка архива: %s", archivePath)
		if err := extractZip(archivePath, tmpDir); err != nil {
			log("Ошибка распаковки: %v", err)
			return err
		}
		log("Архив успешно распакован")
	} else {
		binPath = filepath.Join(tmpDir, "mihomo")
		log("Распаковка архива: %s", archivePath)
		if err := extractGz(archivePath, binPath); err != nil {
			log("Ошибка распаковки: %v", err)
			return err
		}
		log("Архив успешно распакован")
	}

	if err := os.Remove(archivePath); err != nil {
		log("Не удалось удалить архив: %v", err)
	} else {
		log("Архив удалён: %s", archivePath)
	}

	isRunning := getPid(req.Core) > 0
	if isRunning {
		c := exec.Command(InitFile, "stop")
		c.Stdout, c.Stderr = f, f
		if err := c.Run(); err != nil {
			log("Ошибка остановки XKeen: %v", err)
			return err
		}
	}

	corePath := "/opt/sbin/" + req.Core
	log("Целевой путь ядра: %s", corePath)

	if req.BackupCore {
		log("Резервное копирование")
		if _, err := os.Stat(corePath); err == nil {
			backupDir := "/opt/sbin/core-backup"
			if err := os.MkdirAll(backupDir, 0755); err != nil {
				log("Ошибка резервного копирования ядра: %v", err)
				return err
			}
			log("Директория бэкапов готова: %s", backupDir)

			backupPath := filepath.Join(backupDir, req.Core+"-"+time.Now().Format("20060102-150405"))
			log("Создаю резервную копию %s в %s", corePath, backupPath)
			if err := os.Rename(corePath, backupPath); err != nil {
				log("Ошибка резервного копирования ядра: %v", err)
				return err
			}
			log("Резервное копирование завершено успешно")
		} else {
			log("Нет существующего ядра, бэкап пропущен")
		}
	} else {
		log("Резервное копирование отключено, удаляю старое ядро")
		if err := os.Remove(corePath); err != nil && !os.IsNotExist(err) {
			log("Ошибка удаления старого ядра: %v", err)
			return err
		}
		log("Старое ядро удалёно либо отсутствовало)")
	}

	log("Перемещаю новое ядро из %s в %s", binPath, corePath)
	if err := os.Rename(binPath, corePath); err != nil {
		log("Ошибка перемещения ядра: %v", err)
		return err
	}
	log("Ядро успешно перемещено")

	log("Устанавливаю права на выполнение для %s", corePath)
	if err := os.Chmod(corePath, 0755); err != nil {
		log("Ошибка установки прав: %v", err)
		return err
	}
	log("Права успешно установлены")

	if isRunning {
		c := exec.Command(InitFile, "start")
		c.Stdout, c.Stderr = f, f
		if err := c.Run(); err != nil {
			log("Ошибка запуска XKeen: %v", err)
			return err
		}
	}
	log("Обновление %s до версии %s успешно завершено", req.Core, req.Version)
	return nil
}

func downloadFile(url, dest string) error {
	resp, err := http.Get(url)
	if err != nil { return err }
	defer resp.Body.Close()

	if resp.StatusCode != 200 { return fmt.Errorf("download failed with status %d", resp.StatusCode) }

	out, err := os.Create(dest)
	if err != nil { return err }
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

func extractZip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil { return err }
	defer r.Close()
	for _, f := range r.File {
		if f.Name != "xray" { continue }

		rc, err := f.Open()
		if err != nil { return err }
		defer rc.Close()

		path := filepath.Join(dest, f.Name)
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil { return err }
		defer out.Close()

		_, err = io.Copy(out, rc)
		return err
	}

	return fmt.Errorf("xray binary not found in archive")
}

func extractGz(src, dest string) error {
	gzFile, err := os.Open(src)
	if err != nil { return err }
	defer gzFile.Close()

	gr, err := gzip.NewReader(gzFile)
	if err != nil { return err }
	defer gr.Close()

	out, err := os.Create(dest)
	if err != nil { return err }
	defer out.Close()

	_, err = io.Copy(out, gr)
	return err
}