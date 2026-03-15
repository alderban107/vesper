defmodule Vesper.Repo.Migrations.AddChannelCategories do
  use Ecto.Migration

  def change do
    alter table(:channels) do
      add :category_id, references(:channels, type: :binary_id, on_delete: :nilify_all)
      modify :type, :string, size: 16, null: false, default: "text"
    end

    create index(:channels, [:category_id])
  end
end
