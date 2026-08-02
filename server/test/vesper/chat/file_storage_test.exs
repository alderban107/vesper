defmodule Vesper.Chat.FileStorageTest do
  @moduledoc """
  Tests for FileStorage, focusing on the upload directory resolution.

  In Docker releases, Application.app_dir resolves to a versioned path
  (e.g. /app/lib/vesper-<version>/priv/uploads) that is wiped on container
  recreation. PR #41 fixed this by reading from :upload_dir app config
  with a stable default in production.
  """

  use ExUnit.Case, async: true

  alias Vesper.Chat.FileStorage

  describe "upload directory resolution" do
    test "store/2 and get_path/1 use configured :upload_dir when set" do
      # Create a temp directory to act as the upload dir
      tmp_dir =
        Path.join(System.tmp_dir!(), "vesper_test_uploads_#{System.unique_integer([:positive])}")

      File.mkdir_p!(tmp_dir)

      # Write a test file to upload
      source =
        Path.join(System.tmp_dir!(), "vesper_test_source_#{System.unique_integer([:positive])}")

      File.write!(source, "test content for upload dir config")

      previous = Application.get_env(:vesper, :upload_dir)

      try do
        Application.put_env(:vesper, :upload_dir, tmp_dir)

        {:ok, storage_key} = FileStorage.store(source, "test.txt")

        # File should be stored inside the configured directory, not the app_dir path
        stored_path = FileStorage.get_path(storage_key)
        assert String.starts_with?(stored_path, tmp_dir)
        assert File.exists?(stored_path)

        # Clean up the stored file
        FileStorage.delete(storage_key)
        refute File.exists?(stored_path)
      after
        # Restore previous config
        if previous do
          Application.put_env(:vesper, :upload_dir, previous)
        else
          Application.delete_env(:vesper, :upload_dir)
        end

        File.rm_rf!(tmp_dir)
        File.rm(source)
      end
    end

    test "store/2 falls back to Application.app_dir when :upload_dir is not set" do
      source =
        Path.join(System.tmp_dir!(), "vesper_test_fallback_#{System.unique_integer([:positive])}")

      File.write!(source, "test content for fallback path")

      previous = Application.get_env(:vesper, :upload_dir)

      try do
        Application.delete_env(:vesper, :upload_dir)

        {:ok, storage_key} = FileStorage.store(source, "test.txt")

        stored_path = FileStorage.get_path(storage_key)
        app_dir = Application.app_dir(:vesper, "priv/uploads")
        assert String.starts_with?(stored_path, app_dir)
        assert File.exists?(stored_path)

        FileStorage.delete(storage_key)
      after
        if previous do
          Application.put_env(:vesper, :upload_dir, previous)
        end

        File.rm(source)
      end
    end

    test "avatar_dir and banner_dir are under the configured :upload_dir" do
      tmp_dir =
        Path.join(System.tmp_dir!(), "vesper_test_subdirs_#{System.unique_integer([:positive])}")

      previous = Application.get_env(:vesper, :upload_dir)

      try do
        Application.put_env(:vesper, :upload_dir, tmp_dir)

        assert FileStorage.avatar_dir() == Path.join(tmp_dir, "avatars")
        assert FileStorage.banner_dir() == Path.join(tmp_dir, "banners")
      after
        if previous do
          Application.put_env(:vesper, :upload_dir, previous)
        else
          Application.delete_env(:vesper, :upload_dir)
        end
      end
    end
  end
end
