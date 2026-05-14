package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	FPS         int    `json:"fps"`
	OutputDir   string `json:"output_dir"`
	AudioDevice string `json:"audio_device"` // "" = off, "auto" = auto-detect, or device name
}

func DefaultConfig() *Config {
	home, _ := os.UserHomeDir()
	return &Config{
		Width:       1080,
		Height:      720,
		FPS:         30,
		OutputDir:   filepath.Join(home, "Movies", "Randall"),
		AudioDevice: "auto",
	}
}

func configDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".randall")
}

func ConfigPath() string {
	return filepath.Join(configDir(), "config.json")
}

func Load() (*Config, error) {
	cfg := DefaultConfig()
	data, err := os.ReadFile(ConfigPath())
	if err != nil {
		if os.IsNotExist(err) {
			_ = cfg.Save()
			return cfg, nil
		}
		return cfg, nil
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return DefaultConfig(), nil
	}
	return cfg, nil
}

func (c *Config) Save() error {
	if err := os.MkdirAll(configDir(), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ConfigPath(), data, 0644)
}
