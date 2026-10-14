"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FileText, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { getModule } from "@/lib/modules";

interface Template {
  id: string;
  name: string;
  content: string;
  category: string;
  organizationId: string;
  vertical?: string | null;
}

export default function TemplatesPage() {
  const { userData } = useAuth();
  const { module: moduleId } = useParams<{ module: string }>();
  const moduleVertical = getModule(moduleId)?.vertical ?? null;
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userData?.organizationId) {
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, "templates"),
      where("organizationId", "==", userData.organizationId)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const tmps: Template[] = [];
      snapshot.forEach((doc) => {
        tmps.push({ id: doc.id, ...doc.data() } as Template);
      });
      setTemplates(tmps);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userData?.organizationId]);

  const openCreate = () => {
    setEditingTemplate(null);
    setName("");
    setContent("");
    setCategory("");
    setDialogOpen(true);
  };

  const openEdit = (template: Template) => {
    setEditingTemplate(template);
    setName(template.name);
    setContent(template.content);
    setCategory(template.category);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim() || !content.trim() || !userData?.organizationId) return;

    setSaving(true);
    try {
      if (editingTemplate) {
        await updateDoc(doc(db, "templates", editingTemplate.id), {
          name: name.trim(),
          content: content.trim(),
          category: category.trim(),
        });
      } else {
        await addDoc(collection(db, "templates"), {
          name: name.trim(),
          content: content.trim(),
          category: category.trim(),
          organizationId: userData.organizationId,
          ...(moduleVertical ? { vertical: moduleVertical } : {}),
          createdAt: serverTimestamp(),
        });
      }
      setDialogOpen(false);
    } catch (error) {
      console.error("Error saving template:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm("Eliminar esta plantilla?")) return;
    try {
      await deleteDoc(doc(db, "templates", templateId));
    } catch (error) {
      console.error("Error deleting template:", error);
    }
  };

  // Group by category
  // En un módulo: plantillas de ese módulo y las antiguas sin vertical (compartidas)
  const visibleTemplates = moduleVertical
    ? templates.filter((t) => !t.vertical || t.vertical === moduleVertical)
    : templates;

  const categories = Array.from(new Set(visibleTemplates.map((t) => t.category || "General")));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Plantillas</h1>
          <p className="text-gray-500">Respuestas rapidas reutilizables</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              Nueva Plantilla
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingTemplate ? "Editar Plantilla" : "Nueva Plantilla"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label htmlFor="tpl-name">Nombre</Label>
                <Input
                  id="tpl-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Saludo inicial"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-category">Categoria</Label>
                <Input
                  id="tpl-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="Ej: Ventas, Servicio, General"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-content">Contenido</Label>
                <textarea
                  id="tpl-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Escribe el texto de la plantilla..."
                  rows={4}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
              <Button onClick={handleSave} disabled={saving || !name.trim() || !content.trim()} className="w-full">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {editingTemplate ? "Guardar Cambios" : "Crear Plantilla"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {visibleTemplates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-gray-100 p-4 mb-4">
              <FileText className="h-8 w-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium mb-2">Sin plantillas</h3>
            <p className="text-gray-500 text-center">
              Crea plantillas de respuesta rapida para tu equipo.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {categories.map((cat) => (
            <div key={cat}>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
                {cat}
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {visibleTemplates
                  .filter((t) => (t.category || "General") === cat)
                  .map((template) => (
                    <Card key={template.id}>
                      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                        <CardTitle className="text-sm font-medium">
                          {template.name}
                        </CardTitle>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(template)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => handleDelete(template.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-gray-600 whitespace-pre-wrap">
                          {template.content}
                        </p>
                        {template.category && (
                          <Badge variant="secondary" className="mt-2 text-xs">
                            {template.category}
                          </Badge>
                        )}
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
